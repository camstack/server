/**
 * wrapper-identity — what SHELL is this node running inside, and what proved
 * it. Pure: every probe is an input, so the whole table is testable without a
 * filesystem.
 *
 * ## The rule (D437): observe what you can, declare only what you cannot
 *
 * On 2026-08-02 `scripts/check-deployment-templates.ts` proved every day that
 * the templates DECLARED `ghcr.io/camstack/camstack:intel-latest`, while the
 * hub actually ran `camstack-server:intel-1.1.74` from a repository that had
 * been renamed and received no builds. The declaration was right, reality was
 * not, and nothing compared them. A `CAMSTACK_WRAPPER=docker` written into a
 * compose template would be exactly that same declaration — so `kind` is never
 * an env var, and the only env in play is `CAMSTACK_AGENT_APP_VERSION`, which
 * already exists (`packages/desktop/src/main.ts` writes it, `agent-http.ts`
 * reads it).
 *
 * What a node can honestly observe about its own shell:
 *
 *   | fact              | probe                                   | mode     |
 *   |-------------------|-----------------------------------------|----------|
 *   | in a container    | `/.dockerenv`, `/proc/1/cgroup`         | observed |
 *   | not in a container| a non-linux platform                    | observed |
 *   | inside Electron   | `CAMSTACK_AGENT_APP_VERSION`            | declared |
 *
 * The Electron row has no honest alternative: the node is a CHILD of the
 * Electron main process, so `process.versions.electron` is `undefined` here.
 * That is why the row is marked `declared` rather than dressed up as a fact.
 *
 * Two verdicts exist purely to refuse a guess, and they are the point:
 *
 *  - **`contradictory`** — an Electron declaration inside an observed
 *    container. Both proofs stay on `evidence` and nothing picks a winner. A
 *    resolver here would be the 2026-08-02 failure with extra steps: it would
 *    silently prefer one source over the other and nothing would ever compare
 *    them again.
 *  - **`unknown`** — the container probe could not run at all (linux, no
 *    `/.dockerenv`, `/proc/1/cgroup` unreadable). Exclusion needs a probe that
 *    ANSWERED; a shell we could not identify is never `native` by default,
 *    the same discipline with which `assessImageContract` refuses to say
 *    `in-sync` without evidence.
 *
 * Zero-dep (bundled next to the starter); the shape it returns is
 * `WrapperIdentitySchema` in `@camstack/types` (type-only import).
 */
import type { WrapperEvidence, WrapperIdentity } from '@camstack/types'

/**
 * What the impure probes returned. Injected into `RootUpdateService` so the
 * whole table above is exercisable on a developer Mac — a detector that can
 * only be tested by running it inside a container is a detector nobody tests.
 */
export interface WrapperProbeReadings {
  /** `process.platform`. A linux container cannot exist on darwin or win32. */
  readonly platform: string
  /** Does `/.dockerenv` exist? The docker runtime's own marker file. */
  readonly dockerEnvFileExists: boolean
  /**
   * Contents of `/proc/1/cgroup`, or `null` when the read FAILED or the path
   * does not exist. `null` is not "no container" — it is "no answer", and the
   * two must never collapse.
   */
  readonly proc1Cgroup: string | null
}

export interface WrapperIdentityInputs extends WrapperProbeReadings {
  /**
   * `CAMSTACK_AGENT_APP_VERSION` — `app.getVersion()`, written by the Electron
   * main process into the child's env. Absent when the node runs headless or
   * in Docker.
   */
  readonly electronAppVersion: string | undefined
  /**
   * Baked seed closure version — the one fingerprint a container / app bundle
   * can read from inside (see `image-contract.ts`). `null` in a dev workspace.
   */
  readonly seedVersion: string | null
}

/**
 * The ONE env var this detector reads, and it already existed:
 * `packages/desktop/src/main.ts` writes `app.getVersion()` into the child's
 * env, and `server/backend/src/agent/agent-http.ts` reads it for
 * `/api/agent/status`. Nothing here ever declares the wrapper KIND — see D437.
 */
export const ELECTRON_APP_VERSION_ENV = 'CAMSTACK_AGENT_APP_VERSION'

/** Container runtimes whose name appears in a task's cgroup path. */
const CONTAINER_CGROUP_MARKERS: readonly string[] = ['docker', 'containerd', 'kubepods', 'podman']

function cgroupNamesAContainer(contents: string): boolean {
  const lower = contents.toLowerCase()
  return CONTAINER_CGROUP_MARKERS.some((marker) => lower.includes(marker))
}

/** First line that names a container runtime, else the first line, trimmed. */
function cgroupDetail(contents: string): string {
  const lines = contents.split('\n').filter((line) => line.trim().length > 0)
  const named = lines.find((line) => cgroupNamesAContainer(line))
  return (named ?? lines[0] ?? '').trim().slice(0, 200)
}

/**
 * The shell verdict, with every probe on the record — the ones that held and
 * the ones that did not. See the module docblock for why the absent ones
 * matter as much: they are the whole distance between `native` and `unknown`.
 */
export function detectWrapperIdentity(inputs: WrapperIdentityInputs): WrapperIdentity {
  const { platform, dockerEnvFileExists, proc1Cgroup, electronAppVersion, seedVersion } = inputs

  const linux = platform === 'linux'
  const cgroupAnswered = proc1Cgroup !== null
  const cgroupSaysContainer = proc1Cgroup !== null && cgroupNamesAContainer(proc1Cgroup)
  const containerObserved = dockerEnvFileExists || cgroupSaysContainer
  const electronDeclared = electronAppVersion !== undefined && electronAppVersion.length > 0

  // A negative is only an exclusion when a probe ANSWERED: either the cgroup
  // read succeeded, or the platform itself rules a linux container out.
  const containerRuledOut = !containerObserved && (cgroupAnswered || !linux)

  const evidence: WrapperEvidence[] = [
    {
      fact: 'platform',
      mode: 'observed',
      holds: linux,
      detail: linux
        ? `process.platform=${platform} — a container is possible here`
        : `process.platform=${platform} — a linux container cannot run on this platform`,
    },
    {
      fact: 'dockerenv-file',
      mode: 'observed',
      holds: dockerEnvFileExists,
      detail: dockerEnvFileExists ? '/.dockerenv exists' : '/.dockerenv not present',
    },
    {
      fact: 'proc-1-cgroup',
      mode: 'observed',
      holds: cgroupSaysContainer,
      detail:
        proc1Cgroup === null
          ? '/proc/1/cgroup unreadable — this probe did NOT answer'
          : cgroupDetail(proc1Cgroup),
    },
    {
      fact: 'electron-app-version-env',
      mode: 'declared',
      holds: electronDeclared,
      detail: electronDeclared
        ? `CAMSTACK_AGENT_APP_VERSION=${String(electronAppVersion)}`
        : 'CAMSTACK_AGENT_APP_VERSION not set',
    },
  ]

  if (containerObserved && electronDeclared) {
    // Reported, not resolved. Neither version can be attributed to the shell.
    return { kind: 'contradictory', evidence, currentVersion: null }
  }
  if (containerObserved) {
    return { kind: 'docker', evidence, currentVersion: seedVersion }
  }
  if (electronDeclared) {
    return { kind: 'electron', evidence, currentVersion: electronAppVersion ?? null }
  }
  if (containerRuledOut) {
    return { kind: 'native', evidence, currentVersion: seedVersion }
  }
  return { kind: 'unknown', evidence, currentVersion: null }
}
