/**
 * RootUpdateService — the shared install/update engine for a node's
 * runtime-updatable ROOT package. Post-consolidation there is a SINGLE root
 * package (`@camstack/server`) for every node role; the hub's
 * `ServerUpdateService` and the agent's `AgentUpdateService` are thin
 * adapters over this one class (they differ only in restart semantics).
 *
 * SINGLE-COPY model (2026-07-18 collapse):
 *   - stage a new `<pkg>@X` closure into a same-fs `.staging-*` dir
 *     (npm install), validate it (entry + version + native prebuilds),
 *   - write the `.pending-root-swap.json` marker and self-restart — the
 *     STARTER performs the atomic swap of the ONE `current/` copy on the next
 *     boot (nothing holds `current` open then), then loads it,
 *   - back the `server-management` cap methods on every node type.
 *
 * There is NO `versions/<X>` + N-1 rollback copy, NO probation boot, and NO
 * auto-rollback. Operator's accepted tradeoff: a bad update is recovered
 * manually (re-apply a known-good version, or reinstall the image seed).
 *
 * Spec: docs/superpowers/specs/2026-07-18-single-framework-copy-collapse-design.md
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type {
  RunnerBootCheck,
  ServerBootMode,
  ServerPackageStatus,
  ServerUpdateActionResult,
  ServerUpdateCheckResult,
  ServerUpdateState,
  UpdateBlocker,
  WrapperIdentity,
} from '@camstack/types'
import {
  DEV_UPLOADS_KEEP_COUNT,
  devChannelEpoch,
  devUploadVersionDir,
  devUploadsDir,
  isDevChannelVersion,
  readDevUploadManifest,
} from './dev-uploads.js'
import { assessImageContract } from './image-contract.js'
import type { RootPackageSpec } from './root-package-spec.js'
import { compareSemver } from './semver-compare.js'
import { rootEntryPath, rootPackageDir, serverRootDir, validateClosureDir } from './root-state.js'
import {
  currentDir,
  findMissingNativePrebuilds,
  findUnappliedClosurePatches,
  readPendingRootSwap,
  stagingDirPath,
  sweepTransientRootDirs,
  writePendingRootSwap,
} from './root-single-copy.js'
import { detectWorkspaceRoot } from './workspace-detect.js'
import {
  detectWrapperIdentity,
  ELECTRON_APP_VERSION_ENV,
  type WrapperProbeReadings,
} from './wrapper-identity.js'

const execFileAsync = promisify(execFile)

/** npm registry override args — mirrors addon-package.service (module-local there). */
function buildNpmRegistryArgs(registry: string | undefined): readonly string[] {
  if (registry === undefined || registry.length === 0) return []
  return ['--registry', registry, `--@camstack:registry=${registry}`]
}

export type NpmExecFn = (
  args: readonly string[],
  opts: { readonly cwd?: string; readonly timeoutMs: number },
) => Promise<{ stdout: string }>

/**
 * Structural logger surface — satisfied by the hub's `IScopedLogger` AND the
 * agent's console logger, without a runtime dependency on `@camstack/types`.
 */
export interface RootUpdateLogContext {
  /**
   * Structural log tags. Every line this service emits carries `nodeId` —
   * "why is the hub still on 1.2.201 while both agents reached 1.2.205" is
   * always asked PER NODE, and a line that omits the tag cannot answer it.
   */
  readonly tags?: { readonly nodeId?: string }
  readonly meta?: Record<string, unknown>
}

export interface RootUpdateLogger {
  debug(message: string, context?: RootUpdateLogContext): void
  info(message: string, context?: RootUpdateLogContext): void
  warn(message: string, context?: RootUpdateLogContext): void
  error(message: string, context?: RootUpdateLogContext): void
}

/** Per-node env-var names the update service reads (written by the starter). */
export interface RootUpdateEnvNames {
  /** `workspace` / `baked` / `data-root` marker set by the starter. */
  readonly bootMode: string
  /** Active data-root version (data-root boots only). */
  readonly activeVersion: string
  /** Directory of the immutable baked seed root package (image-set). */
  readonly seedDir: string
}

/**
 * What an update-driven restart is ABOUT, handed to the restart seam alongside
 * the reason string.
 *
 * The reason string can spell exactly one version, so the version the node is
 * LEAVING had nowhere to go — and after the reboot nothing can recover it,
 * because the process asking is the new one. The `.restart-pending` marker (and
 * therefore the operator's "Server aggiornato" notification) is only ever as
 * complete as this object.
 */
export interface RootRestartUpdate {
  readonly packageName: string
  /** Absent only when the running copy has no readable package.json. */
  readonly fromVersion?: string
  readonly toVersion: string
}

export interface RootUpdateServiceOptions {
  readonly spec: RootPackageSpec
  readonly envNames: RootUpdateEnvNames
  readonly logger: RootUpdateLogger
  /**
   * The node this service updates — stamped as `tags.nodeId` on EVERY line it
   * emits. Adapters supply their own identity (`hub`, the agent's node id);
   * `unknown` only when a caller genuinely has none, which is never true in
   * production wiring.
   */
  readonly nodeId?: string
  /**
   * Graceful restart seam (hub: AddonPackageService.restartServer; agent:
   * SIGTERM self). `update` is present only for an update-driven restart and
   * carries both versions — see {@link RootRestartUpdate}.
   */
  readonly restartServer: (requestedBy: string, update?: RootRestartUpdate) => void
  /** The node's resolved data dir (adapters own the per-node default). */
  readonly dataDir: string
  /** package.json of the RUNNING root-package copy (adapters own the default). */
  readonly runningPackageJsonPath: string
  /** Anchor for the boot-mode fallback classification (adapter `__dirname`). */
  readonly workspaceProbeDir: string
  /**
   * Optional post-install native-prebuild ENSURE step, injected from the
   * construction site (the node-root layer is zero-dep and cannot fetch npm
   * packages itself). Runs in `stageClosure` AFTER the npm install and BEFORE
   * `findMissingNativePrebuilds` validates the closure.
   *
   * Why: on a packaged desktop with no build toolchain the auto
   * `prebuild-install` install-script path can leave a traditional native
   * (`better-sqlite3`) SOURCE-ONLY — the closure then fails the native-prebuild
   * validator and the swap is refused ("staged closure missing native
   * prebuilds"). This hook fetches the missing prebuild for the RUNNING Node
   * ABI so a legitimate update is not needlessly blocked. Harmless on docker /
   * tests (the prebuilds already landed → a no-op). Injected, so node-root
   * keeps ZERO runtime deps and the fetch is unit-testable with a fake.
   */
  readonly ensureNativePrebuilds?: (closureDir: string) => Promise<void>
  /**
   * Apply the root package's SHIPPED closure patches to the staged closure.
   *
   * Why this is not left to npm: `@camstack/server`'s `postinstall` is what
   * applies them, and npm 12 blocks a dependency's install scripts by default
   * (`allowScripts`). Measured 2026-09-13 on the Mac-mini agent, which had
   * bootstrapped npm 12.0.1 while hub and agent-a still ran npm 11 — the
   * staged closure carried `werift` unpatched, `findUnappliedClosurePatches`
   * refused it, and the node sat two versions behind with no other symptom.
   *
   * {@link allowScripts} (below) tells npm 12 to run those scripts again, but a
   * patch of OURS must not depend on any npm policy to reach production: that
   * dependency is what D478 was written to remove. So this runs unconditionally
   * and the applier is idempotent by design — every hunk recognises its own
   * output, so applying twice is a no-op, not a double patch.
   *
   * Best-effort, exactly like {@link ensureNativePrebuilds}: a throw is logged
   * and `findUnappliedClosurePatches` still decides, because the validator's
   * message names the marker and is the clearer one to put in front of an
   * operator. Injected so node-root keeps ZERO runtime deps.
   */
  readonly applyClosurePatches?: (closureDir: string) => Promise<void>
  /**
   * The impure half of the wrapper detection — the two filesystem probes that
   * say whether this process sits in a container. Injected so the whole
   * identity table is exercisable on a developer Mac; defaults to
   * {@link readWrapperProbes}, which reads the real paths.
   */
  readonly readWrapperProbes?: () => WrapperProbeReadings
  /**
   * Pre-flight (D877): which addons would the TARGET version refuse to start
   * on this node's live data? Injected - node-root is zero-dep and cannot read
   * the settings store. An empty list means "nothing known to refuse". A throw
   * means "could not ask": the update proceeds (a store hiccup must not freeze
   * every update) and the failure is logged.
   */
  readonly updatePreflight?: (targetVersion: string) => Promise<readonly UpdateBlocker[]>
  /**
   * The node's runner boot check (D877), served on `getServerPackageStatus`.
   * `undefined` until the one-shot check has run.
   */
  readonly runnerBootCheck?: () => RunnerBootCheck | undefined
  /** Overrides for tests. */
  readonly execNpm?: NpmExecFn
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => number
  /** Pause between staging attempts (see {@link STAGING_RETRY_DELAYS_MS}); tests inject a no-op. */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Why a request to change the running root package was DROPPED. Stable, named
 * values — an operator greps `reason=` and a future guard can count them.
 */
export type UpdateRefusalReason =
  | 'workspace-boot-mode'
  | 'operation-in-flight'
  | 'already-staged'
  | 'latest-unresolved'
  | 'already-running'
  | 'dev-uploads-missing'
  | 'addon-would-refuse'

/** Why a plain (version-preserving) restart was dropped. */
export type RestartRefusalReason = 'operation-in-flight' | 'already-staged'

interface CheckCache {
  readonly latestVersion: string | null
  readonly checkedAtMs: number
  readonly error: string | null
}

const NPM_VIEW_TIMEOUT_MS = 20_000
const NPM_INSTALL_TIMEOUT_MS = 15 * 60_000

/**
 * How many times the staging install is attempted, and the pause before each
 * retry. Only a TRANSIENT npm network failure ({@link isTransientNpmNetworkError})
 * is retried — a validator refusal or a 404 is the same answer every time.
 *
 * Why retry at all: the install is idempotent (every attempt gets a fresh
 * `.staging-*` dir and a failed one is removed), a registry `ECONNRESET`
 * fails in seconds, and "Update all nodes" walks the fleet once — a single
 * reset left one node behind with nothing to do but ask again by hand
 * (2026-09-19 21:04Z on the hub). Why bounded: a registry that is DOWN must
 * surface as a failure in under a minute, not hold the caller against the
 * 16-minute forward timeout. Three attempts, ~20 s of waiting in total.
 */
export const STAGING_ATTEMPTS = 3
export const STAGING_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000]

/**
 * npm's own vocabulary for "the network dropped, not the package": the error
 * codes it prints for connection resets, DNS hiccups and gateway timeouts, plus
 * the `npm error network` banner it puts on every one of them. Anything else —
 * `E404`, `ETARGET`, a validator message from `stageClosure` — is final.
 */
const TRANSIENT_NPM_ERROR_RE =
  /npm error code (?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|E50[234]|E429)\b|npm error network/i

export function isTransientNpmNetworkError(message: string): boolean {
  return TRANSIENT_NPM_ERROR_RE.test(message)
}

/** Stable `reason` a staging install that never landed reports (see `ServerUpdateOutcome`). */
export const STAGING_FAILED_REASON = 'staging-failed'
/** Stable `reason` for the rollback the single-copy model cannot perform. */
export const ROLLBACK_UNSUPPORTED_REASON = 'rollback-unsupported'

/**
 * The packages whose install scripts the staged closure MUST be allowed to run.
 *
 * npm 12 blocks a dependency's install scripts unless the installing manifest
 * names it here; npm 11 and earlier ignore the field and run them all. So this
 * list is not new policy — it is the npm-11 behaviour, written down, so that
 * moving a node to npm 12 stops being a silent downgrade.
 *
 * Measured 2026-09-13 on the Mac-mini agent (npm 12.0.1): seven packages were
 * blocked. Each one here does something the closure cannot do without:
 *   - `@camstack/server`  applies the shipped closure patches (D478),
 *   - `better-sqlite3`    fetches/builds the native the settings store needs,
 *   - `node-av`           fetches the ffmpeg binaries the decode path needs,
 *   - `node-pty`, `ssh2`, `cpu-features`, `esbuild` — natives and platform
 *     binaries that were building under npm 11 and must keep building.
 *
 * `findMissingNativePrebuilds` still refuses a closure where one of these did
 * not land. This list is how a legitimate update stops NEEDING to be refused.
 */
const CLOSURE_ALLOW_SCRIPTS: Readonly<Record<string, true>> = {
  '@camstack/server': true,
  'better-sqlite3': true,
  'node-av': true,
  'node-pty': true,
  ssh2: true,
  'cpu-features': true,
  esbuild: true,
}
const RESTART_REASON_PREFIX = 'server-update'
/** Transient (`.staging-*` / `.trash-*`) dirs younger than this are never swept. */
const STALE_TRANSIENT_MS = 24 * 60 * 60 * 1000

/**
 * The impure half of the wrapper detection: the two paths a container's own
 * runtime leaves behind. A failed read is `null` — "this probe did not answer"
 * — and NEVER `''`, because the detector turns "no answer" into `unknown`
 * while an empty string would read as "checked, no container" and hand a node
 * the `native` verdict it did not earn.
 */
export function readWrapperProbes(): WrapperProbeReadings {
  let proc1Cgroup: string | null = null
  try {
    proc1Cgroup = fs.readFileSync('/proc/1/cgroup', 'utf-8')
  } catch {
    proc1Cgroup = null
  }
  let dockerEnvFileExists = false
  try {
    dockerEnvFileExists = fs.existsSync('/.dockerenv')
  } catch {
    dockerEnvFileExists = false
  }
  return { platform: process.platform, dockerEnvFileExists, proc1Cgroup }
}

function readPackageVersion(pkgJsonPath: string): string | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
    if (typeof raw === 'object' && raw !== null) {
      const version = (raw as Record<string, unknown>)['version']
      if (typeof version === 'string') return version
    }
  } catch {
    // missing / malformed — treated as unknown
  }
  return null
}

export class RootUpdateService {
  private readonly spec: RootPackageSpec
  private readonly envNames: RootUpdateEnvNames
  private readonly logger: RootUpdateLogger
  /** Frozen `tags` object stamped on every line — see {@link RootUpdateLogContext}. */
  private readonly logTags: { readonly nodeId: string }
  private readonly restartServerFn: (requestedBy: string, update?: RootRestartUpdate) => void
  private readonly dataDir: string
  private readonly updatePreflightFn:
    | ((targetVersion: string) => Promise<readonly UpdateBlocker[]>)
    | null
  private readonly runnerBootCheckFn: () => RunnerBootCheck | undefined
  private readonly execNpm: NpmExecFn
  private readonly ensureNativePrebuildsFn: (closureDir: string) => Promise<void>
  private readonly applyClosurePatchesFn: (closureDir: string) => Promise<void>
  private readonly env: NodeJS.ProcessEnv
  private readonly readWrapperProbesFn: () => WrapperProbeReadings
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly runningPackageJsonPath: string
  private readonly workspaceProbeDir: string
  /**
   * The version THIS PROCESS loaded — read once, here, from the package.json
   * of the copy the code came from, and never again. The file is the only
   * place the fact exists in a form the process can read, and the moment of
   * construction is the only moment it is guaranteed to describe what is in
   * memory: the starter swaps `current/` BEFORE loading the entry, and nothing
   * else may move it, so a later read that disagrees is a disk that changed
   * under a live process — reported through `installedVersion`, never folded
   * into this number.
   */
  private readonly loadedVersion: string | null

  private checkCache: CheckCache | null = null
  private inFlight: 'idle' | 'checking' | 'staging' = 'idle'

  constructor(options: RootUpdateServiceOptions) {
    this.spec = options.spec
    this.envNames = options.envNames
    this.logger = options.logger
    this.logTags = { nodeId: options.nodeId ?? 'unknown' }
    this.restartServerFn = options.restartServer
    this.dataDir = path.resolve(options.dataDir)
    this.updatePreflightFn = options.updatePreflight ?? null
    this.runnerBootCheckFn = options.runnerBootCheck ?? (() => undefined)
    this.execNpm =
      options.execNpm ??
      (async (args, opts) => {
        const { stdout } = await execFileAsync('npm', [...args], {
          cwd: opts.cwd,
          timeout: opts.timeoutMs,
        })
        return { stdout }
      })
    this.ensureNativePrebuildsFn = options.ensureNativePrebuilds ?? (async () => undefined)
    this.applyClosurePatchesFn = options.applyClosurePatches ?? (async () => undefined)
    this.env = options.env ?? process.env
    this.readWrapperProbesFn = options.readWrapperProbes ?? readWrapperProbes
    this.now = options.now ?? Date.now
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms)
        }))
    this.runningPackageJsonPath = options.runningPackageJsonPath
    this.workspaceProbeDir = options.workspaceProbeDir
    this.loadedVersion = readPackageVersion(this.runningPackageJsonPath)
    // The starter wrote the version it booted into the environment of this
    // same process. The two can only disagree if the copy on disk moved
    // between the starter's read and this one — a fact worth one line, never
    // a silent pick of either side.
    const bootedVersion = this.env[this.envNames.activeVersion]
    if (
      bootedVersion !== undefined &&
      this.loadedVersion !== null &&
      bootedVersion !== this.loadedVersion
    ) {
      this.logger.warn('running root package disagrees with the version the starter booted', {
        tags: this.logTags,
        meta: { loadedVersion: this.loadedVersion, bootedVersion },
      })
    }
  }

  // ── Status ────────────────────────────────────────────────────────────

  resolveBootMode(): ServerBootMode {
    const raw = this.env[this.envNames.bootMode]
    if (raw === 'workspace' || raw === 'baked' || raw === 'data-root') return raw
    // The starter didn't run (dev tsx entry, `npm start`, or a pre-starter
    // image) — classify by checkout shape.
    return detectWorkspaceRoot(this.workspaceProbeDir) !== null ? 'workspace' : 'baked'
  }

  /** What THIS process loaded — see {@link loadedVersion}. Never a disk read. */
  private runningVersion(): string | null {
    return this.loadedVersion
  }

  /**
   * What is in the data-root `current/` copy RIGHT NOW — the version the next
   * boot would load if nothing is staged. Only answered on a `data-root` boot:
   * on a workspace boot there is no such copy, and on a `baked` boot the
   * starter already judged `current/` unloadable (or absent), so a version
   * read from it would claim "runs after restart" about code that will not.
   */
  private installedVersion(): string | null {
    if (this.resolveBootMode() !== 'data-root') return null
    return readPackageVersion(
      path.join(rootPackageDir(currentDir(this.rootDir()), this.spec), 'package.json'),
    )
  }

  /**
   * The three facts a restart question needs, read together so no surface can
   * quote one without the others: what is staged, what is on disk, and whether
   * the code that would run after a restart differs from the code running now.
   */
  private restartFacts(): {
    readonly pendingVersion: string | null
    readonly installedVersion: string | null
    readonly restartRequired: boolean
  } {
    const pendingVersion = readPendingRootSwap(this.rootDir())?.version ?? null
    const installedVersion = this.installedVersion()
    const running = this.runningVersion()
    const restartRequired =
      pendingVersion !== null ||
      (installedVersion !== null && running !== null && installedVersion !== running)
    return { pendingVersion, installedVersion, restartRequired }
  }

  /** The running root package's identity — feeds registerNode / topology rows. */
  getRunningRootPackage(): { readonly name: string; readonly version: string | null } {
    return { name: this.spec.packageName, version: this.runningVersion() }
  }

  private seedVersion(): string | null {
    const seedDir = this.env[this.envNames.seedDir]
    if (seedDir === undefined || seedDir.length === 0) return null
    return readPackageVersion(path.join(seedDir, 'package.json'))
  }

  /**
   * What this node runs INSIDE. Observed where it can be (the container
   * probes), declared only where it cannot (the Electron app version, which a
   * child process has no other way to learn). A contradiction between the two
   * is reported as `contradictory`, never resolved — see `wrapper-identity.ts`
   * and D437.
   */
  private wrapperIdentity(): WrapperIdentity {
    return detectWrapperIdentity({
      ...this.readWrapperProbesFn(),
      electronAppVersion: this.env[ELECTRON_APP_VERSION_ENV],
      seedVersion: this.seedVersion(),
    })
  }

  private rootDir(): string {
    return serverRootDir(this.dataDir)
  }

  private updateState(): ServerUpdateState {
    if (this.inFlight === 'checking') return 'checking'
    if (this.inFlight === 'staging') return 'staging'
    // A staged version awaiting the swap-on-restart shows as pending-restart.
    if (readPendingRootSwap(this.rootDir()) !== null) return 'pending-restart'
    return 'idle'
  }

  /**
   * `latest` is an update this node can still TAKE: newer than what runs, and
   * not the version already staged here — that one is a restart away, and
   * re-applying it is refused (`already-staged`).
   */
  private isUpdateAvailable(
    latestVersion: string | null,
    runningVersion: string | null,
    pendingVersion: string | null,
  ): boolean {
    return (
      latestVersion !== null &&
      runningVersion !== null &&
      latestVersion !== pendingVersion &&
      compareSemver(latestVersion, runningVersion) > 0
    )
  }

  async getServerPackageStatus(): Promise<ServerPackageStatus> {
    const runningVersion = this.runningVersion()
    const latestVersion = this.checkCache?.latestVersion ?? null
    const { pendingVersion, installedVersion, restartRequired } = this.restartFacts()
    const updateAvailable = this.isUpdateAvailable(latestVersion, runningVersion, pendingVersion)
    return {
      packageName: this.spec.packageName,
      runningVersion,
      nodeRuntimeVersion: process.versions.node,
      activeVersion: this.env[this.envNames.activeVersion] ?? runningVersion,
      installedVersion,
      restartRequired,
      // Single-copy model: no N-1 retention, no rollback record.
      previousVersion: null,
      seedVersion: this.seedVersion(),
      latestVersion,
      updateAvailable,
      bootMode: this.resolveBootMode(),
      updateState: this.updateState(),
      pendingVersion,
      rolledBack: null,
      stateFileCorrupt: false,
      lastCheckedAtMs: this.checkCache?.checkedAtMs ?? null,
      // Seed-vs-contract verdict: `runningVersion` can be perfectly current
      // (applyServerUpdate) while the IMAGE is weeks old from a dead repo —
      // 2026-08-02, hub on `camstack-server:intel-1.1.74` with every other
      // field green. See `image-contract.ts` for the full account.
      imageContract: assessImageContract({
        seedVersion: this.seedVersion(),
        latestVersion,
        runningVersion,
      }),
      // The other half of the same question. `imageContract` says the shell is
      // BEHIND; this says WHAT the shell is, which is the only thing that can
      // turn that verdict into an instruction the operator can act on.
      wrapper: this.wrapperIdentity(),
      // Planned runners against the process service's states (D877); absent
      // until the one-shot boot check has run.
      ...(this.runnerBootCheckFn() !== undefined ? { runners: this.runnerBootCheckFn() } : {}),
    }
  }

  // ── Check ─────────────────────────────────────────────────────────────

  async checkServerUpdate(): Promise<ServerUpdateCheckResult> {
    const runningVersion = this.runningVersion()
    // Read once per check, so the three answers below describe ONE moment.
    const { pendingVersion, restartRequired } = this.restartFacts()
    if (this.inFlight !== 'idle') {
      return {
        packageName: this.spec.packageName,
        runningVersion,
        latestVersion: this.checkCache?.latestVersion ?? null,
        updateAvailable: false,
        checkedAtMs: this.checkCache?.checkedAtMs ?? this.now(),
        error: `busy: ${this.inFlight}`,
        pendingVersion,
        restartRequired,
      }
    }
    this.inFlight = 'checking'
    try {
      const registry = this.env['CAMSTACK_NPM_REGISTRY']
      const args = [
        'view',
        `${this.spec.packageName}@latest`,
        'version',
        ...buildNpmRegistryArgs(registry),
      ]
      const { stdout } = await this.execNpm(args, { timeoutMs: NPM_VIEW_TIMEOUT_MS })
      const latestVersion = stdout.trim().length > 0 ? stdout.trim() : null
      this.checkCache = { latestVersion, checkedAtMs: this.now(), error: null }
      // The one moment this node holds a FRESH registry answer — say it out
      // loud if the image diverges from the contract. A stale image is
      // invisible in every other field (the 2026-08-02 renamed-repo hub), and
      // a divergence nothing logs reads as "never happened". Logged here, not
      // in getServerPackageStatus, which the UI polls every 10s.
      const imageContract = assessImageContract({
        seedVersion: this.seedVersion(),
        latestVersion,
        runningVersion,
      })
      if (imageContract.state === 'behind-patch' || imageContract.state === 'behind-series') {
        this.logger.warn(
          `image seed diverges from the release contract: ${imageContract.message}`,
          {
            meta: {
              state: imageContract.state,
              seedVersion: imageContract.seedVersion,
              contractVersion: imageContract.contractVersion,
            },
          },
        )
      }
      const updateAvailable = this.isUpdateAvailable(latestVersion, runningVersion, pendingVersion)
      return {
        packageName: this.spec.packageName,
        runningVersion,
        latestVersion,
        updateAvailable,
        checkedAtMs: this.checkCache.checkedAtMs,
        error: null,
        pendingVersion,
        restartRequired,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.checkCache = {
        latestVersion: this.checkCache?.latestVersion ?? null,
        checkedAtMs: this.now(),
        error: message,
      }
      this.logger.warn('root package update check failed', { meta: { error: message } })
      return {
        packageName: this.spec.packageName,
        runningVersion,
        latestVersion: this.checkCache.latestVersion,
        updateAvailable: false,
        checkedAtMs: this.checkCache.checkedAtMs,
        error: message,
        pendingVersion,
        restartRequired,
      }
    } finally {
      this.inFlight = 'idle'
    }
  }

  // ── Apply ─────────────────────────────────────────────────────────────

  /**
   * Every `accepted:false` return from the update engine goes through here.
   *
   * A refusal DROPS the operator's request: nothing is staged, nothing
   * restarts. Before 2026-09-01 it also said nothing — six branches returned
   * `{accepted:false}` in silence, so "the hub refused" and "the hub was never
   * called" produced identical evidence (none), and the operator lost an
   * evening to the difference. The reason is now named, per-node greppable and
   * on the record before the caller sees the result.
   */
  private refuseUpdate(
    reason: UpdateRefusalReason,
    targetVersion: string | null,
    message: string,
  ): ServerUpdateActionResult {
    this.logger.warn('root package update refused', {
      tags: this.logTags,
      meta: { reason, targetVersion, message },
    })
    return {
      accepted: false,
      targetVersion,
      restarting: false,
      message,
      // "Already running" is not a gate saying no — it is the work already
      // done. Every other reason is a refusal the caller may need to clear.
      outcome: reason === 'already-running' ? 'already-current' : 'refused',
      reason,
      error: null,
    }
  }

  private async runPreflight(target: string): Promise<readonly UpdateBlocker[]> {
    if (this.updatePreflightFn === null) return []
    try {
      return await this.updatePreflightFn(target)
    } catch (err) {
      this.logger.warn('update pre-flight could not run - proceeding without it', {
        tags: this.logTags,
        meta: { targetVersion: target, error: err instanceof Error ? err.message : String(err) },
      })
      return []
    }
  }

  async applyServerUpdate(input: {
    version?: string
    acknowledgeRefusals?: boolean
  }): Promise<ServerUpdateActionResult> {
    // The ENTRY line. Its absence in 12 h of hub logs on 2026-09-01 is what
    // proved the cluster page never reached this node at all — no later line
    // can carry that, because a request that is never made has no outcome.
    this.logger.info('root package update requested', {
      tags: this.logTags,
      meta: { requestedVersion: input.version ?? null, packageName: this.spec.packageName },
    })
    const bootMode = this.resolveBootMode()
    if (bootMode === 'workspace') {
      return this.refuseUpdate(
        'workspace-boot-mode',
        input.version ?? null,
        'Refused: running from a workspace checkout — the dev loop resolves code from the ' +
          'workspace, a data-root update would never be loaded.',
      )
    }
    if (this.inFlight !== 'idle') {
      return this.refuseUpdate(
        'operation-in-flight',
        input.version ?? null,
        `Refused: another operation is in flight (${this.inFlight}).`,
      )
    }
    const pendingBefore = readPendingRootSwap(this.rootDir())
    if (pendingBefore !== null) {
      return this.refuseUpdate(
        'already-staged',
        input.version ?? null,
        `Refused: version ${pendingBefore.version} is already staged and awaiting restart.`,
      )
    }

    // Resolve the target version (explicit or latest from the registry).
    let target = input.version ?? null
    if (target === null) {
      const check = await this.checkServerUpdate()
      if (check.error !== null || check.latestVersion === null) {
        return this.refuseUpdate(
          'latest-unresolved',
          null,
          `Refused: could not resolve the latest version (${check.error ?? 'no version returned'}).`,
        )
      }
      target = check.latestVersion
    }

    const runningVersion = this.runningVersion()
    if (target === runningVersion) {
      return this.refuseUpdate(
        'already-running',
        target,
        `Refused: ${this.spec.packageName}@${target} is already running.`,
      )
    }

    // Dev server-deploy channel. A `-dev.<epoch>` version stages EXCLUSIVELY
    // from tarballs previously landed in THIS node's
    // `server-root/dev-uploads/<version>/` — it never exists on npm. Hub:
    // `POST /api/server-upload`. Agents: `POST /api/server-upload/propagate`
    // (`camstack deploy-server -n <id>` / `--all`) which writes the same layout
    // via `$agent.stageDevUploads`.
    if (isDevChannelVersion(target)) {
      const uploadsDir = devUploadVersionDir(this.rootDir(), target)
      if (!fs.existsSync(uploadsDir)) {
        return this.refuseUpdate(
          'dev-uploads-missing',
          target,
          `Refused: dev-channel version ${target} has no uploaded tarballs on this node ` +
            `(${uploadsDir} is missing). On the hub: \`camstack deploy-server\`. ` +
            'On an agent: `camstack deploy-server -n <nodeId>` (or `--all`) so the hub ' +
            'can POST /api/server-upload/propagate first.',
        )
      }
    }

    // Pre-flight (D877): an update that would leave addons refusing to start is
    // refused BEFORE anything is staged or swapped.
    const blockers = await this.runPreflight(target)
    if (blockers.length > 0 && input.acknowledgeRefusals !== true) {
      const names = blockers.map((b) => b.addonId).join(', ')
      const remedies = [...new Set(blockers.map((b) => b.remedy))].join(' ')
      const refused = this.refuseUpdate(
        'addon-would-refuse',
        target,
        `Refused: ${this.spec.packageName}@${target} would refuse to start ${blockers.length} addon(s) ` +
          `on this node's data: ${names}. ${remedies} Then retry, or pass acknowledgeRefusals to ` +
          'apply anyway (those addons will stay down).',
      )
      return { ...refused, blockers: [...blockers] }
    }
    if (blockers.length > 0) {
      this.logger.warn('root package update applied over acknowledged addon refusals', {
        tags: this.logTags,
        meta: { targetVersion: target, addonIds: blockers.map((b) => b.addonId) },
      })
    }

    this.inFlight = 'staging'
    let stagingPath: string
    try {
      stagingPath = await this.stageClosureWithRetry(target)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        accepted: false,
        targetVersion: target,
        restarting: false,
        message: `Staging failed: ${message}`,
        outcome: 'failed',
        reason: STAGING_FAILED_REASON,
        error: message,
      }
    } finally {
      this.inFlight = 'idle'
    }

    // Arm the swap-on-restart + schedule the graceful restart.
    writePendingRootSwap(this.rootDir(), {
      schemaVersion: 1,
      version: target,
      stagingPath,
      requestedAtMs: this.now(),
    })
    this.logger.info('root package update staged — restarting to apply', {
      tags: this.logTags,
      meta: { targetVersion: target, fromVersion: runningVersion },
    })
    this.restartServerFn(`${RESTART_REASON_PREFIX}: ${this.spec.packageName}@${target}`, {
      packageName: this.spec.packageName,
      ...(runningVersion !== null ? { fromVersion: runningVersion } : {}),
      toVersion: target,
    })
    return {
      accepted: true,
      targetVersion: target,
      restarting: true,
      message:
        `Staged ${this.spec.packageName}@${target} — restarting to apply (single automatic reboot). ` +
        `Until that restart completes the node still runs ${runningVersion ?? 'the previous version'}.`,
      outcome: 'staged',
      reason: null,
      error: null,
    }
  }

  /**
   * {@link stageClosure}, attempted up to {@link STAGING_ATTEMPTS} times when
   * the failure is a transient registry network error and ONLY then. Every
   * attempt is logged with its ordinal; the final failure is logged at ERROR
   * with the attempt count, so a log that shows one line shows the whole
   * story. Throws the last error when every attempt failed.
   */
  private async stageClosureWithRetry(target: string): Promise<string> {
    let lastError: unknown = new Error('staging never ran')
    for (let attempt = 1; attempt <= STAGING_ATTEMPTS; attempt += 1) {
      try {
        return await this.stageClosure(target)
      } catch (err) {
        lastError = err
        const message = err instanceof Error ? err.message : String(err)
        const transient = isTransientNpmNetworkError(message)
        const delayMs = STAGING_RETRY_DELAYS_MS[attempt - 1]
        const willRetry = transient && attempt < STAGING_ATTEMPTS && delayMs !== undefined
        if (!willRetry) {
          this.logger.error('root package update staging failed', {
            tags: this.logTags,
            meta: {
              targetVersion: target,
              attempt,
              attempts: STAGING_ATTEMPTS,
              transient,
              error: message,
            },
          })
          break
        }
        this.logger.warn('root package update staging failed — transient network error, retrying', {
          tags: this.logTags,
          meta: {
            targetVersion: target,
            attempt,
            attempts: STAGING_ATTEMPTS,
            delayMs,
            error: message,
          },
        })
        await this.sleep(delayMs)
      }
    }
    throw lastError
  }

  /**
   * npm-install the target closure into a SAME-FS `.staging-*` dir, then
   * validate it (entry + version + native prebuilds). Returns the staging dir
   * path for the pending-root-swap marker; the STARTER swaps it into `current`
   * on the next boot. Throws (cleaning up the staging dir) on any failure so
   * `applyServerUpdate` reports a staging error and never arms a bad swap.
   */
  private async stageClosure(target: string): Promise<string> {
    const rootDir = this.rootDir()
    fs.mkdirSync(rootDir, { recursive: true })
    const stagingDir = stagingDirPath(rootDir, target, process.pid, this.now())
    fs.mkdirSync(stagingDir, { recursive: true })

    try {
      // Dev server-deploy channel: when tarballs for `target` were uploaded to
      // `server-root/dev-uploads/<target>/`, stage from THEM instead of the
      // registry — a synthetic package.json depends on the root tgz via
      // `file:` and pins every other uploaded package through `overrides`.
      const devDir = devUploadVersionDir(rootDir, target)
      const registry = this.env['CAMSTACK_NPM_REGISTRY']
      const installArgs = ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error']
      if (fs.existsSync(devDir)) {
        fs.writeFileSync(
          path.join(stagingDir, 'package.json'),
          JSON.stringify(this.buildDevUploadsPackageJson(devDir, target), null, 2),
          'utf-8',
        )
        await this.execNpm([...installArgs, ...buildNpmRegistryArgs(registry)], {
          cwd: stagingDir,
          timeoutMs: NPM_INSTALL_TIMEOUT_MS,
        })
      } else {
        fs.writeFileSync(
          path.join(stagingDir, 'package.json'),
          JSON.stringify(
            { name: 'camstack-node-root', private: true, allowScripts: CLOSURE_ALLOW_SCRIPTS },
            null,
            2,
          ),
          'utf-8',
        )
        await this.execNpm(
          [...installArgs, `${this.spec.packageName}@${target}`, ...buildNpmRegistryArgs(registry)],
          { cwd: stagingDir, timeoutMs: NPM_INSTALL_TIMEOUT_MS },
        )
      }

      const entry = rootEntryPath(stagingDir, this.spec)
      if (!fs.existsSync(entry)) {
        throw new Error(`staged closure is missing the root entry (${entry})`)
      }
      const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
      const invalid = validateClosureDir(stagingDir, nodeMajor, this.spec, target)
      if (invalid !== null) {
        throw new Error(`staged closure invalid: ${invalid}`)
      }
      // Post-install native-prebuild ENSURE (injected) — fetch any traditional
      // native (`better-sqlite3`) prebuild the npm install left source-only on a
      // toolchain-less packaged host, BEFORE the validator below refuses the
      // swap. Best-effort: a fetch failure must not mask the clearer validator
      // error, so it is logged and the validator still decides. No-op default.
      try {
        await this.ensureNativePrebuildsFn(stagingDir)
      } catch (err) {
        this.logger.warn('native-prebuild ensure step failed — validator will decide', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
      // Native prebuild assertion — a runner that can't load node-av/sharp/
      // better-sqlite3 breaks decode/snapshot/db. Abort BEFORE arming the swap.
      const missingNatives = findMissingNativePrebuilds(stagingDir)
      if (missingNatives.length > 0) {
        throw new Error(
          `staged closure missing native prebuilds: ${missingNatives.join(', ')} — ` +
            'refusing to arm a swap that would break the forked runners',
        )
      }
      // Apply our own shipped patches, without asking npm's permission. The
      // package's `postinstall` does this too, but npm 12 blocks it by default
      // and a silently-unpatched closure is exactly what D478 exists to stop.
      // Idempotent, so this is a no-op wherever npm did run the lifecycle.
      try {
        await this.applyClosurePatchesFn(stagingDir)
      } catch (err) {
        this.logger.warn('closure-patch apply step failed — validator will decide', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
      // Closure-patch assertion (D478) — `@camstack/server`'s `postinstall`
      // applies the patches that cannot be bundled (werift), and it is
      // best-effort by design. This is the half that is not: a closure whose
      // patch markers are absent is refused here, BEFORE the swap is armed,
      // with the marker named. `werift` ran unpatched in production for eight
      // weeks because nothing asked this question anywhere.
      const unpatched = findUnappliedClosurePatches(stagingDir)
      if (unpatched.length > 0) {
        throw new Error(
          `staged closure did not apply its shipped patches: ${unpatched.join(', ')} — ` +
            'refusing to arm a swap into an unpatched closure',
        )
      }
      return stagingDir
    } catch (err) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
  }

  /**
   * Synthetic staging package.json for the dev server-deploy channel:
   * `dependencies` carries the root package as a `file:` ref to its uploaded
   * tgz; `overrides` maps EVERY OTHER uploaded `@camstack/<name>` to its tgz.
   * Fail-closed: a missing/invalid manifest, a manifest for a different
   * version, a missing root package, or a listed-but-absent tgz all throw.
   */
  private buildDevUploadsPackageJson(
    devDir: string,
    target: string,
  ): {
    readonly name: string
    readonly private: true
    readonly allowScripts: Readonly<Record<string, true>>
    readonly dependencies: Readonly<Record<string, string>>
    readonly overrides?: Readonly<Record<string, string>>
  } {
    const manifest = readDevUploadManifest(devDir)
    if (manifest === null) {
      throw new Error(`dev-uploads manifest missing or invalid in ${devDir}`)
    }
    if (manifest.version !== target) {
      throw new Error(
        `dev-uploads manifest version mismatch: dir is for ${target}, manifest says ${manifest.version}`,
      )
    }
    const rootTgz = manifest.packages[this.spec.packageName]
    if (rootTgz === undefined) {
      throw new Error(
        `dev-uploads for ${target} do not include the root package ${this.spec.packageName}`,
      )
    }
    const fileRef = (filename: string): string => {
      const abs = path.join(devDir, filename)
      if (!fs.existsSync(abs)) {
        throw new Error(`dev-uploads tarball listed in the manifest is missing: ${abs}`)
      }
      return `file:${abs}`
    }
    const overrides: Record<string, string> = {}
    for (const [pkgName, filename] of Object.entries(manifest.packages)) {
      if (pkgName === this.spec.packageName) continue
      overrides[pkgName] = fileRef(filename)
    }
    return {
      name: 'camstack-node-root',
      private: true,
      allowScripts: CLOSURE_ALLOW_SCRIPTS,
      dependencies: { [this.spec.packageName]: fileRef(rootTgz) },
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    }
  }

  // ── Rollback (removed — single-copy has no N-1) ────────────────────────

  /**
   * Rollback is NOT supported in the single-copy model — there is no retained
   * N-1 copy to revert to (operator's accepted tradeoff). Recovery is manual:
   * re-apply a known-good version via {@link applyServerUpdate}, or reinstall
   * the image seed. Kept on the surface so the cap contract is unchanged.
   */
  async rollbackServerUpdate(): Promise<ServerUpdateActionResult> {
    return {
      accepted: false,
      targetVersion: null,
      restarting: false,
      message:
        'Rollback is not supported in the single-copy model (no retained previous version). ' +
        'Recover by re-applying a known-good version via applyServerUpdate, or reinstall the image seed.',
      outcome: 'refused',
      reason: ROLLBACK_UNSUPPORTED_REASON,
      error: null,
    }
  }

  // ── Plain restart ─────────────────────────────────────────────────────

  /**
   * Plain process restart — no version change. Refuse while a stage is in
   * flight (a concurrent npm install must not be interrupted) or while a
   * version is already staged awaiting restart (a naive bounce would boot the
   * OLD version and orphan the pending swap — the operator should apply
   * instead).
   */
  /** {@link refuseUpdate}'s twin for the plain-restart path. */
  private refuseRestart(
    reason: RestartRefusalReason,
    targetVersion: string | null,
    message: string,
  ): ServerUpdateActionResult {
    this.logger.warn('plain node restart refused', {
      tags: this.logTags,
      meta: { reason, targetVersion, message },
    })
    return {
      accepted: false,
      targetVersion,
      restarting: false,
      message,
      outcome: 'refused',
      reason,
      error: null,
    }
  }

  restartNode(): ServerUpdateActionResult {
    const runningVersion = this.runningVersion()
    if (this.inFlight !== 'idle') {
      return this.refuseRestart(
        'operation-in-flight',
        runningVersion,
        `Refused: another operation is in flight (${this.inFlight}).`,
      )
    }
    if (readPendingRootSwap(this.rootDir()) !== null) {
      return this.refuseRestart(
        'already-staged',
        runningVersion,
        'Refused: a version is staged and awaiting restart — apply it instead of a plain restart.',
      )
    }
    this.logger.info('plain node restart requested', {
      tags: this.logTags,
      meta: { runningVersion },
    })
    this.restartServerFn(`${RESTART_REASON_PREFIX}: manual restart`)
    return {
      accepted: true,
      targetVersion: runningVersion,
      restarting: true,
      message: 'Restarting the node — the supervisor relaunches it on the same version.',
      outcome: 'restart-scheduled',
      reason: null,
      error: null,
    }
  }

  // ── Boot health confirmation ──────────────────────────────────────────

  /**
   * Called by the post-boot path once the node is READY. In the single-copy
   * model there is no pending version to promote (the swap already happened in
   * the starter). This becomes a best-effort GC of orphaned transient dirs
   * (`.staging-*` / `.trash-*` left by a crash mid-swap) + the dev-uploads
   * sweep. Kept returning the legacy `{ promoted }` shape for the callers.
   */
  confirmBootHealthy(): { promoted: string | null } {
    sweepTransientRootDirs(this.rootDir(), this.now(), STALE_TRANSIENT_MS)
    this.sweepDevUploads(DEV_UPLOADS_KEEP_COUNT)
    return { promoted: null }
  }

  /**
   * Promote-time sweep of `server-root/dev-uploads/`: keep only the
   * `keepCount` most recent entries (ordered by the self-describing
   * `-dev.<epochSeconds>` suffix; non-dev-shaped residue counts as oldest).
   */
  private sweepDevUploads(keepCount: number): void {
    const dir = devUploadsDir(this.rootDir())
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return // no dev-uploads dir — nothing to sweep
    }
    const graveyard = path.join(dir, '.sweeping')
    // Best-effort collect residue left behind by an earlier sweep first.
    try {
      for (const residue of fs.readdirSync(graveyard)) {
        try {
          fs.rmSync(path.join(graveyard, residue), { recursive: true, force: true })
        } catch {
          /* still held open — retried on the next promote */
        }
      }
    } catch {
      /* graveyard absent — nothing to collect */
    }

    const versions = entries.filter((name) => !name.startsWith('.'))
    const byNewestFirst = [...versions].sort(
      (a, b) => (devChannelEpoch(b) ?? -1) - (devChannelEpoch(a) ?? -1),
    )
    const doomed = byNewestFirst.slice(keepCount)
    if (doomed.length === 0) return
    fs.mkdirSync(graveyard, { recursive: true })
    for (const entry of doomed) {
      const aside = path.join(graveyard, `${entry}-${this.now()}`)
      try {
        fs.renameSync(path.join(dir, entry), aside)
      } catch (err) {
        this.logger.warn('failed to move dev-uploads entry aside for sweep', {
          meta: { entry, error: err instanceof Error ? err.message : String(err) },
        })
        continue
      }
      try {
        fs.rmSync(aside, { recursive: true, force: true })
        this.logger.debug('swept dev-uploads entry', { meta: { entry } })
      } catch {
        /* held open — the aside copy is collected on the next promote */
      }
    }
  }
}
