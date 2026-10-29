import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * server-management — per-NODE singleton capability for a node's ROOT
 * package lifecycle (runtime-updatable node packages).
 *
 * Every node role runs the SAME root package (`@camstack/server`), which
 * carries the whole software stack in its npm dep tree, so ONE version
 * describes the node. Updates stage into `<dataDir>/server-root/` and apply
 * on restart via the baked starter (single-copy in-place swap — no probation,
 * no auto-rollback).
 *
 * Providers:
 *   - HUB: `ServerUpdateService` behind the `server-provided` mount
 *     (`buildServerProviders` in trpc.router.ts) — the default target for
 *     unpinned calls.
 *   - AGENT: `AgentUpdateService` registered by the agent bootstrap under
 *     the synthetic `agent-runtime` addonId and declared in the agent's
 *     `$hub.registerNode` manifest.
 *
 * Node routing: singleton caps get the codegen/runtime-builder `nodeId`
 * injection on every method — `input.nodeId` (or `nodePin(nodeId)` from the
 * SDK) routes the call to that node's provider via the standard remote
 * proxy (`createCapabilityProxy` → `$agent-cap-fwd` → the agent's
 * in-process provider lookup). No `nodeId` → the hub's own provider.
 *
 * Spec: docs/superpowers/specs/2026-07-12-runtime-updatable-node-packages-design.md
 */

// ── Status ───────────────────────────────────────────────────────────

/**
 * Where the running hub's code was loaded from:
 *  - `workspace` — dev checkout (tsx / workspace dist); the starter defers to
 *    plain resolution and runtime updates are refused.
 *  - `baked`     — the immutable image seed closure (no data-dir root active).
 *  - `data-root` — the runtime-updatable `<dataDir>/server-root` closure.
 */
const ServerBootModeSchema = z.enum(['workspace', 'baked', 'data-root'])

/**
 * Update lifecycle state:
 *  - `idle` / `checking` / `staging` — steady / in-flight registry work.
 *  - `pending-restart` — a version is staged and the node has NOT yet
 *    restarted onto it (still running the OLD version).
 *  - `awaiting-confirmation` — RETIRED with the probation boot (single-copy
 *    collapse, 2026-07-18). Kept in the enum so an older client still parses;
 *    no provider emits it.
 */
const ServerUpdateStateSchema = z.enum([
  'idle',
  'checking',
  'staging',
  'pending-restart',
  'awaiting-confirmation',
])

/**
 * Verdict of comparing the node's IMMUTABLE baked seed (the Docker image / the
 * desktop app bundle) against the release the deployment contract would
 * deliver today. `applyServerUpdate` swaps the data-root closure and NEVER
 * touches the image, so `runningVersion` can be perfectly current while the
 * container is weeks old, from a renamed repository nothing rebuilds — which
 * is exactly what happened on 2026-08-02 (hub on `camstack-server:intel-1.1.74`
 * while every existing surface said "up to date"). The seed version is the one
 * image fingerprint a container can see from inside (no docker socket).
 *
 *  - `in-sync`       — seed equals the current release; the node runs the
 *                      contract image.
 *  - `behind-patch`  — same release series, older patch: the image predates
 *                      the current release. Normal between deliberate image
 *                      refreshes, but the starter/entrypoint are still old.
 *  - `behind-series` — the seed's major/minor predates the current release
 *                      series. The shape of a pinned tag or a dead image
 *                      repository; a `docker pull` may fix nothing.
 *  - `ahead`         — seed newer than the best-known release (stale registry
 *                      check).
 *  - `unknown`       — no seed (dev workspace) or nothing to compare against
 *                      yet.
 */
const ImageContractStateSchema = z.enum([
  'in-sync',
  'behind-patch',
  'behind-series',
  'ahead',
  'unknown',
])

const ImageContractSchema = z.object({
  state: ImageContractStateSchema,
  /** The baked seed closure version — the image/app-bundle fingerprint. */
  seedVersion: z.string().nullable(),
  /** Best-known version the deployment contract delivers today. */
  contractVersion: z.string().nullable(),
  /**
   * Where `contractVersion` came from: a real registry check (`registry`), or
   * the node's own running version (`running` — a node can never run code
   * newer than the newest release, so `seed < running` proves image staleness
   * even before any registry check has run).
   */
  contractSource: z.enum(['registry', 'running']).nullable(),
  /** One operator-grade sentence: this node runs image X; the contract says Y. */
  message: z.string(),
})

/**
 * How this node's SHELL was identified — the process wrapper the node runs
 * inside (a Docker container, the Electron desktop app, a bare host process).
 *
 * ## The rule: observe what you can, declare only what you cannot
 *
 * On 2026-08-02 `check-deployment-templates.ts` proved every day that the
 * templates declared `ghcr.io/camstack/camstack:intel-latest` while the hub
 * actually ran `camstack-server:intel-1.1.74` from a repository that had been
 * renamed and received no builds. The declaration was right; reality was not;
 * nothing compared them. A `CAMSTACK_WRAPPER=docker` written into a template
 * would be exactly that same declaration, so `kind` is NEVER an env var.
 *
 * What can honestly be observed from inside: `/.dockerenv` and `/proc/1/cgroup`
 * (a container), and the platform (a Linux container cannot exist on darwin or
 * win32). What cannot: that the node is a CHILD of an Electron main process —
 * `process.versions.electron` is `undefined` in the child, so the only channel
 * is `CAMSTACK_AGENT_APP_VERSION`, which the main process already writes
 * (`packages/desktop/src/main.ts`). That one declaration is unavoidable, and it
 * is marked as such on every row of {@link WrapperEvidenceSchema}.
 *
 *  - `docker`        — container observed, no Electron declaration.
 *  - `electron`      — Electron declared, no container observed.
 *  - `native`        — the container probe RAN and found nothing, and there is
 *                      no Electron declaration. Exclusion, but only from a
 *                      probe that actually answered.
 *  - `contradictory` — an Electron declaration INSIDE an observed container.
 *                      Reported, never resolved: both proofs stay on
 *                      `evidence` and nothing picks a winner.
 *  - `unknown`       — the container probe could not run (a Linux host that
 *                      denied `/proc/1/cgroup`). Never `native` by default,
 *                      for the same reason `assessImageContract` refuses to
 *                      say `in-sync` without proof.
 *
 * See D437.
 */
const WrapperKindSchema = z.enum(['docker', 'electron', 'native', 'contradictory', 'unknown'])

/**
 * One probe and what it returned — including the probes that returned
 * NOTHING. A record listing only the facts that held cannot tell "checked,
 * absent" from "never checked", and that difference is the whole distance
 * between `native` and `unknown`.
 */
const WrapperEvidenceSchema = z.object({
  /** Which probe this row reports. */
  fact: z.enum(['dockerenv-file', 'proc-1-cgroup', 'platform', 'electron-app-version-env']),
  /**
   * `observed` — this process read it itself. `declared` — the shell told the
   * process and nothing here can check it. Only the Electron app version is
   * ever `declared`, and only because a child cannot see its parent.
   */
  mode: z.enum(['observed', 'declared']),
  /** Did the probe support the fact it names? A `false` row is still evidence. */
  holds: z.boolean(),
  /** What was actually read, verbatim enough for an operator to argue with. */
  detail: z.string(),
})

/**
 * The shell verdict (see {@link WrapperKindSchema}) with the proofs that
 * produced it.
 *
 * There is deliberately NO `canSelfUpdate` boolean: a wrapper update is an
 * ANNOUNCEMENT. The notification body carries the exact command for a `docker`
 * shell and says the app restarts into the new build for `electron`, and that
 * sentence is chosen from `kind` alone — a boolean nothing reads is the defect
 * this repo keeps paying for. The one shell that CAN be acted on is the
 * Electron app, and only through `installDesktopUpdate` (see
 * {@link DesktopAppStatusSchema} for what the node reads from the app first).
 */
const WrapperIdentitySchema = z.object({
  kind: WrapperKindSchema,
  /** Every probe that ran, in a stable order. Never empty. */
  evidence: z.array(WrapperEvidenceSchema),
  /**
   * The version of the SHELL, when the shell has one it can state: the
   * Electron app version it declared, or the baked seed closure that
   * fingerprints a container / app bundle. `null` for `contradictory` and
   * `unknown` — which version belongs to the shell is precisely what is not
   * known there.
   */
  currentVersion: z.string().nullable(),
})

const ServerRollbackInfoSchema = z.object({
  /** The version that failed (or was manually rolled back). */
  fromVersion: z.string(),
  /** The version rolled back to; null = the baked seed. */
  toVersion: z.string().nullable(),
  atMs: z.number(),
  reason: z.string(),
})

/**
 * What the native desktop app (Electron) that hosts this node says about
 * itself, read from `<dataDir>/server-root/desktop-app-state.json` (ADR-0971).
 * Absent on the status = no desktop app, or it never wrote the file.
 *
 * `stale` is the honest answer to an app that stopped writing (closed, hung,
 * crashed): the update facts are then the LAST ones known, not current ones,
 * and a consumer must not read `update.available: false` from a stale record
 * as "no update". `stateAtMs` is when the app last wrote.
 */
const DesktopAppStatusSchema = z.object({
  /** The Electron app's own version (not the node closure's). */
  version: z.string(),
  update: z.object({
    available: z.boolean(),
    /** The new build is downloaded and `installDesktopUpdate` can apply it. */
    downloaded: z.boolean(),
    version: z.string().nullable(),
    checking: z.boolean(),
    /** Why the app's last update check produced no answer; `null` when it did. */
    error: z.string().nullable(),
  }),
  stateAtMs: z.number(),
  stale: z.boolean(),
})

/**
 * Why `installDesktopUpdate` did nothing. Stable names a UI maps to a sentence:
 *  - `not-electron`   — this node does not run inside the desktop app.
 *  - `no-app-state`   — the app never published its state (or the file is unreadable).
 *  - `app-state-stale` — the app stopped writing; it is probably not running.
 *  - `not-downloaded` — no update is downloaded yet; nothing to install.
 */
const InstallDesktopUpdateReasonSchema = z.enum([
  'not-electron',
  'no-app-state',
  'app-state-stale',
  'not-downloaded',
])

const InstallDesktopUpdateResultSchema = z.object({
  accepted: z.boolean(),
  /** Non-null exactly when `accepted` is false. */
  reason: InstallDesktopUpdateReasonSchema.nullable(),
})

/**
 * The runner boot check (D877): the runners this node PLANNED (hub: one per
 * `resolveRunnerId` over its forked addons; agent: the runners its process
 * service holds, because only the hub plans) against the states the process
 * service reports. Kept in memory, recomputed by the same one-shot check after
 * every boot, served on `getServerPackageStatus`.
 *
 * `failed` is the D6 breaker's terminal state, `refused` a deterministic Init
 * refusal (an addon that said "I will not start, and here is why"), `missing` a
 * planned runner the process service has no entry for.
 */
const RunnerRefusalSchema = z.object({
  runnerId: z.string(),
  addonIds: z.array(z.string()),
  reason: z.string(),
})

const RunnerBootCheckSchema = z.object({
  checkedAtMs: z.number(),
  /** Runners planned for this node. */
  expected: z.number(),
  /** Planned runners whose process is `running`. */
  running: z.number(),
  failed: z.array(z.string()),
  refused: z.array(RunnerRefusalSchema),
  missing: z.array(z.string()),
  /**
   * Runners still on their way: `starting`, or `crashed` waiting on a backoff
   * respawn. The check is FINAL only when this is empty; until then nothing is
   * pushed and the verdict is re-evaluated on the next runner state change.
   * Optional for version skew (absent = settled).
   */
  pending: z.array(z.string()).optional(),
  /** True when the plan is the hub's (`missing` is then meaningful); false on an agent. */
  planKnown: z.boolean(),
})

const ServerPackageStatusSchema = z.object({
  /** Root package name (`@camstack/server` on the hub). */
  packageName: z.string(),
  /**
   * Version of the code THIS PROCESS loaded — captured once, at boot, from the
   * package.json of the copy the code was loaded from, and never re-read. A
   * copy replaced on disk under a live process must not move this number;
   * that divergence is what `installedVersion` is for. Before 2026-09-20 this
   * was a lazy disk read that would have followed such a swap silently.
   */
  runningVersion: z.string().nullable(),
  /** Node.js runtime version the node's process runs on (`process.versions.node`). */
  nodeRuntimeVersion: z.string().nullable(),
  /** Active data-dir root version; null when booted from seed/workspace. */
  activeVersion: z.string().nullable(),
  /**
   * Version of the root package in the data-root `current/` copy RIGHT NOW —
   * what the next boot would load if nothing is staged. Normally equal to
   * `runningVersion`; differs only when the copy on disk changed under the
   * live process. `null` when there is no data-root copy (baked seed or
   * workspace boot). Optional for version skew: an older provider omits it.
   */
  installedVersion: z.string().nullable().optional(),
  /**
   * True when the code that would run after a restart is NOT the code running
   * now: a version is staged (`pendingVersion`), or `installedVersion` differs
   * from `runningVersion`. Derived on every read, never stored. This is the
   * one field that lets an operator or a script say "1.2.353 is installed and
   * will run after a restart" instead of reading it off a number that means
   * "installed". Optional for version skew.
   */
  restartRequired: z.boolean().optional(),
  /** N-1 version kept for rollback; null when no previous version exists. */
  previousVersion: z.string().nullable(),
  /** Version of the immutable baked seed closure (image fallback). */
  seedVersion: z.string().nullable(),
  /** Latest registry version from the most recent check (null = never checked). */
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  bootMode: ServerBootModeSchema,
  updateState: ServerUpdateStateSchema,
  /** Version staged + awaiting its probation boot, when one is pending. */
  pendingVersion: z.string().nullable(),
  /** Set when the last freshly-activated version failed its boot health-check. */
  rolledBack: ServerRollbackInfoSchema.nullable(),
  /**
   * True when `server-root/state.json` EXISTS but is unreadable/corrupt — the
   * hub is running from the baked seed (or workspace) while installed data-dir
   * versions are being IGNORED. Surfaced as a warning in the UI.
   */
  stateFileCorrupt: z.boolean(),
  lastCheckedAtMs: z.number().nullable(),
  /**
   * Seed-vs-contract verdict (see {@link ImageContractSchema}). Optional for
   * version skew: an older provider's payload simply omits it.
   */
  imageContract: ImageContractSchema.optional(),
  /**
   * What this node runs INSIDE (see {@link WrapperIdentitySchema}). Optional
   * for version skew: an older provider's payload simply omits it, and an
   * absent wrapper is unknown — never `native`.
   */
  wrapper: WrapperIdentitySchema.optional(),
  /**
   * What this node PLANNED to run against what its process service reports
   * (D877). Absent until the one-shot boot check has run (~60 s after boot) and
   * on a provider that predates it. Absent is "not checked yet", never "all
   * well": a consumer that needs the answer treats it as pending.
   */
  runners: RunnerBootCheckSchema.optional(),
  /**
   * The desktop app hosting this node (see {@link DesktopAppStatusSchema}).
   * Optional for version skew AND because most nodes have no desktop app.
   */
  desktopApp: DesktopAppStatusSchema.optional(),
})

// ── Action results ───────────────────────────────────────────────────

const ServerUpdateCheckResultSchema = z.object({
  packageName: z.string(),
  /** Same meaning as on the status payload: what THIS process loaded. */
  runningVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  /**
   * `latestVersion` is newer than `runningVersion` AND is not the version
   * already staged on this node. A staged-and-waiting version is not "an
   * update available" — applying it again is refused (`already-staged`), and
   * a button that announced "updating…" on this boolean then got refused
   * would be lying. It is reported through `pendingVersion` instead.
   */
  updateAvailable: z.boolean(),
  checkedAtMs: z.number(),
  /** Non-null when the registry lookup failed (offline, bad registry, …). */
  error: z.string().nullable(),
  /**
   * Version staged on this node and awaiting its restart, when one is. Before
   * 2026-09-20 a check answered `{runningVersion, updateAvailable:false}` for a
   * node whose staged closure had never booted, and the caller had no way to
   * see the difference. Optional for version skew.
   */
  pendingVersion: z.string().nullable().optional(),
  /** See the status payload: staged, or installed-on-disk ≠ running. Optional for skew. */
  restartRequired: z.boolean().optional(),
})

/**
 * What an action DID — the discriminant `accepted` cannot carry. Before
 * 2026-09-20 `applyServerUpdate` answered `accepted:false` both for a refusal
 * where nothing was wrong (already current, already staged) and for a staging
 * install that died on `npm error code ECONNRESET`; the only difference was
 * prose in `message`, and an operator restarted a container on the strength of
 * it, booting the previous version.
 *
 *  - `staged`            — the closure is installed and validated; the node
 *                          restarts to apply it (`restarting:true`). NOTHING
 *                          runs the new code until that restart completes.
 *  - `restart-scheduled` — a plain, version-preserving restart was accepted.
 *  - `already-current`   — the target IS the running version; nothing done.
 *  - `refused`           — dropped by a gate; `reason` names which.
 *  - `failed`            — attempted and did not land; `error` says why.
 */
const ServerUpdateOutcomeSchema = z.enum([
  'staged',
  'restart-scheduled',
  'already-current',
  'refused',
  'failed',
])

/** One addon the pre-flight found the target version would refuse (D877). */
const UpdateBlockerSchema = z.object({
  addonId: z.string(),
  reason: z.string(),
  /** What the operator does about it. */
  remedy: z.string(),
})

const ServerUpdateActionResultSchema = z.object({
  accepted: z.boolean(),
  targetVersion: z.string().nullable(),
  /** True when a graceful restart was scheduled to apply the change. */
  restarting: z.boolean(),
  message: z.string(),
  /** See {@link ServerUpdateOutcomeSchema}. Optional for version skew. */
  outcome: ServerUpdateOutcomeSchema.optional(),
  /**
   * Stable, greppable cause for `refused` / `failed` (the engine's
   * `UpdateRefusalReason`, `staging-failed`, …). `null` on success.
   */
  reason: z.string().nullable().optional(),
  /**
   * The failure itself, verbatim enough to act on (the npm output for a
   * staging install). Non-null only for `failed`.
   */
  error: z.string().nullable().optional(),
  /**
   * The addons the target version would refuse to start on this node's live
   * store (D877), present when the pre-flight refused the update
   * (`reason: 'addon-would-refuse'`). Optional for version skew.
   */
  blockers: z.array(UpdateBlockerSchema).optional(),
})

const LaunchOverridesSchema = z.object({
  /** The persisted heap ceiling in MB, or `null` when none is set. */
  heapMb: z.number().int().nullable(),
})

const SetLaunchOverridesResultSchema = LaunchOverridesSchema.extend({
  /** Always true: the override is read at launch, not by the running process. */
  restartRequired: z.boolean(),
})

export const serverManagementCapability = {
  name: 'server-management',
  scope: 'system',
  mode: 'singleton',
  methods: {
    getServerPackageStatus: method(z.void(), ServerPackageStatusSchema, { auth: 'admin' }),
    checkServerUpdate: method(z.void(), ServerUpdateCheckResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    applyServerUpdate: method(
      z.object({
        /** Explicit target version; omitted = latest from the registry. */
        version: z.string().optional(),
        /**
         * Apply even though the pre-flight (D877) found addons the target would
         * refuse to start. Off by default: those addons stay down until the
         * remedy is run, which is the incident this gate exists to prevent.
         */
        acknowledgeRefusals: z.boolean().optional(),
      }),
      ServerUpdateActionResultSchema,
      {
        kind: 'mutation',
        auth: 'admin',
        /*
         * `applyServerUpdate` STAGES synchronously before replying: the handler
         * (`RootUpdateService.applyServerUpdate` in `@camstack/node-root`) awaits
         * a full `npm install` of the target closure (bounded by its own
         * `NPM_INSTALL_TIMEOUT_MS = 15min`) and closure validation, THEN arms the
         * swap + returns `{accepted, restarting}`. On the hub the caller reaches
         * this provider directly, but on an AGENT the call crosses the
         * `$agent-cap-fwd.forward` Moleculer forward whose per-call timeout is
         * `capTimeoutMs('server-management','applyServerUpdate') ?? 60_000`. The
         * default 60s < the install window → the forward `Request is timed out`
         * even though the update proceeds on the agent. Declare a timeout that
         * COVERS the npm-install window (15min) plus staging/validation overhead
         * so the forward waits for the real staging result. Keep this ABOVE
         * `NPM_INSTALL_TIMEOUT_MS`.
         */
        timeoutMs: 16 * 60_000,
      },
    ),
    /**
     * Ask the desktop app hosting this node to install its DOWNLOADED update
     * and restart. The request is a file in the node's data dir (the node may
     * be a Windows service, not Electron's child); the app consumes it once.
     * `accepted: true` means the request was WRITTEN — the app restarting is
     * observed afterwards on `desktopApp.version`, not promised here. Refused
     * with a named `reason` when not an electron shell, the app's state is
     * absent or stale, or nothing is downloaded.
     */
    installDesktopUpdate: method(z.void(), InstallDesktopUpdateResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    rollbackServerUpdate: method(z.void(), ServerUpdateActionResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Plain process restart of the node's root process — no version change.
     * The supervisor (docker restart policy / launchd / Electron main)
     * relaunches and the starter loads the SAME active version. Refused while
     * a stage is in flight or a version is already staged awaiting restart
     * (use apply/rollback instead, so the pending version is not skipped).
     */
    restartServer: method(z.void(), ServerUpdateActionResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * The node's persisted launch override (ADR 0970): the heap ceiling the node's
     * `node` process is started with, or `null` when none is set (the closure's
     * computed default applies). Read from the node's own data dir.
     */
    getLaunchOverrides: method(z.void(), LaunchOverridesSchema, { auth: 'admin' }),
    /**
     * Set (`heapMb`) or clear (`null`) the node's heap-ceiling override. It is
     * written on the node itself and applies at the NEXT launch — restart the
     * node (`restartServer`) for it to take effect.
     */
    setLaunchOverrides: method(
      z.object({ heapMb: z.number().int().min(512).max(65536).nullable() }),
      SetLaunchOverridesResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  /** BIG PLAN 2: declarative mount hint — read by `@camstack/system` `buildCapRouters`. */
  mount: { kind: 'server-provided' },
} as const satisfies CapabilityDefinition

export type IServerManagementProvider = InferProvider<typeof serverManagementCapability>

export type ServerBootMode = z.infer<typeof ServerBootModeSchema>
export type ServerUpdateState = z.infer<typeof ServerUpdateStateSchema>
export type ImageContractState = z.infer<typeof ImageContractStateSchema>
export type ImageContract = z.infer<typeof ImageContractSchema>
export type WrapperKind = z.infer<typeof WrapperKindSchema>
export type WrapperEvidence = z.infer<typeof WrapperEvidenceSchema>
export type WrapperIdentity = z.infer<typeof WrapperIdentitySchema>
export type DesktopAppStatus = z.infer<typeof DesktopAppStatusSchema>
export type InstallDesktopUpdateReason = z.infer<typeof InstallDesktopUpdateReasonSchema>
export type InstallDesktopUpdateResult = z.infer<typeof InstallDesktopUpdateResultSchema>
export type ServerRollbackInfo = z.infer<typeof ServerRollbackInfoSchema>
export type ServerPackageStatus = z.infer<typeof ServerPackageStatusSchema>
export type ServerUpdateCheckResult = z.infer<typeof ServerUpdateCheckResultSchema>
export type ServerUpdateOutcome = z.infer<typeof ServerUpdateOutcomeSchema>
export type ServerUpdateActionResult = z.infer<typeof ServerUpdateActionResultSchema>
export type LaunchOverrides = z.infer<typeof LaunchOverridesSchema>
export type SetLaunchOverridesResult = z.infer<typeof SetLaunchOverridesResultSchema>
export type RunnerBootCheck = z.infer<typeof RunnerBootCheckSchema>
export type RunnerRefusal = z.infer<typeof RunnerRefusalSchema>
export type UpdateBlocker = z.infer<typeof UpdateBlockerSchema>

export {
  RunnerBootCheckSchema,
  RunnerRefusalSchema,
  UpdateBlockerSchema,
  ServerBootModeSchema,
  ServerUpdateStateSchema,
  ImageContractStateSchema,
  ImageContractSchema,
  WrapperKindSchema,
  WrapperEvidenceSchema,
  WrapperIdentitySchema,
  DesktopAppStatusSchema,
  InstallDesktopUpdateReasonSchema,
  InstallDesktopUpdateResultSchema,
  ServerRollbackInfoSchema,
  ServerPackageStatusSchema,
  ServerUpdateCheckResultSchema,
  ServerUpdateOutcomeSchema,
  ServerUpdateActionResultSchema,
}
