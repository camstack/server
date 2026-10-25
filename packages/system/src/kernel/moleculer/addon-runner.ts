/**
 * Addon Runner — THE unified entry point for spawned subprocesses.
 *
 * Every spawned process is a size-1 addon set — one addon, one process,
 * zero exceptions (D2/D9). The media-pipeline co-location group was
 * dissolved by Phase 5 once frames and audio chunks became serialisable
 * (shm `FrameHandle`s / tRPC), so no addon declares `execution.group`
 * and `CAMSTACK_RUNNER_ADDONS` always carries a single element. The
 * runner still accepts a multi-element array structurally — that is a
 * mechanism, not a policy; no manifest exercises it.
 *
 * UDS-ONLY (Phase F1+F2 — irreversible). The forked child runs with NO
 * Moleculer `ServiceBroker`. Its only link to the parent (hub or agent)
 * is a `LocalChildClient` over a Unix-domain socket:
 *
 *   - Caps:      `ctx.api.<cap>.<method>(...)` resolves a same-process
 *                sibling via `localProviderLink`; everything else rides
 *                `ipcParentLink → client.callOut` → the parent's
 *                `onUnownedCall` (resolver-first + broker-fallback) — F0.
 *   - Events:    `createUdsEventBus` — local `deliverShared` + UDS forward.
 *   - Logs:      `createUdsLogger` — `client.sendLog` (pre-connect buffered).
 *   - Readiness: `getOrInitReadinessRegistryForClient` — hydrate via
 *                `client.requestReadinessSnapshot()` on connect.
 *   - Registration: the UDS `register`/`updateCaps` message IS the
 *                handshake (the parent applies it via `onChildRegistered`,
 *                mirroring `$hub.registerNode`). No Moleculer RPC.
 *
 * CRITICAL ORDERING: `udsChildClient.start()` MUST resolve BEFORE any addon
 * module is loaded/initialised — addon `initialize()` issues `ctx.api` /
 * `ctx.settings` calls that route over UDS via `ipcParentLink`, and there is
 * no broker fallback anymore. The client's pre-connect buffers flush on
 * connect, so init-time logs/events are preserved.
 *
 * Environment variables:
 * - CAMSTACK_RUNNER_ID        — runner label (becomes the nodeID suffix)
 * - CAMSTACK_RUNNER_ADDONS    — JSON array of `{ addonId, addonDir }`
 * - CAMSTACK_PARENT_NODE_ID   — hub or agent nodeID
 * - CAMSTACK_PARENT_UDS_PATH  — REQUIRED: the parent's UDS endpoint
 * - CAMSTACK_DATA_DIR         — addon data root (default ./camstack-data)
 * - CAMSTACK_LOG_LEVEL        — log level (default debug)
 *
 * Exits non-zero on fatal init failures so the parent process supervisor
 * can respawn. Graceful SIGTERM/SIGINT triggers `addon.shutdown()` for
 * every loaded addon before closing the UDS channel.
 */
import { findAddonRefusal } from '../addon-refused-error.js'
import {
  formatRunnerRefusalLine,
  refusalReportOf,
  RUNNER_REFUSED_EXIT_CODE,
} from './runner-refusal.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  AddonDeclaration,
  AddonInitResult,
  ChildCustomActionCatalogs,
  ICamstackAddon,
  SecretsAccess,
} from '@camstack/types'
import {
  errMsg,
  isCollectionArrayMethodName,
  isProviderOptionalMethodName,
  normalizeAddonInitResult,
  resolveSecretViewsIn,
} from '@camstack/types/addon'
import { resolveAddonClass } from '../addon-class-resolver.js'
import { CustomActionRegistry } from '../custom-action-registry.js'
import { installManifestNativeDeps } from '../deps/manifest-native-deps.js'
import { installManifestPythonDeps } from '../deps/manifest-python-deps.js'
import { installManifestSystemDeps } from '../deps/manifest-system-deps.js'
import { emitHeapDiagnosticReport } from '../heap-spaces.js'
import { RUNNER_RSS_BUDGET_ENV, startRunnerHeapWatch } from '../heap-watch.js'
import { LocalChildClient } from '../transport/local-child-client.js'
import { createUdsLoggerWithControl } from '../transport/uds-logger.js'
import { createUdsAddonContext } from './addon-context-factory.js'
import { validateProviderRegistrations } from './addon-service-factory.js'
import { createChildAddonCallDispatch } from './child-addon-call-dispatch.js'
import { buildChildCapDescriptors } from './child-cap-descriptors.js'
import { createChildCapDispatch } from './child-cap-dispatch.js'
import {
  getWorkerNativeCapProvider,
  getWorkerNativeCapSnapshot,
  setWorkerNativeCapsChangeListener,
} from './device-cap-proxy.js'
import { startInitWatchdog } from './init-watchdog.js'
import { registerFrameworkResolver } from './register-framework-resolver.js'
import {
  killOwnRunnerGroupAfterParentLoss,
  startRunnerParentDeathWatchdog,
} from './runner-process-group.js'
import { runWorkerDeviceRestoreWithRetry } from './worker-device-restore.js'

// ── Crash instrumentation ──────────────────────────────────────────
// The addon-runner had no `uncaughtException` / `unhandledRejection`
// handlers, so a crash printed Node's default trace to stderr (forwarded
// by `process-service`) but an *unhandled rejection* or a silent exit
// left no marked record. These handlers stamp a grep-able marker so the
// death reason is always visible in the captured stream.
//
// Raw `console.error` is deliberate here: these run while the process is
// already crashing/exiting — the UDS channel may be torn down or unreliable,
// and `process.exit` fires synchronously, so an async forwarded log would
// never land. stderr (piped to the supervisor by `process-service`) is the
// only safe sink.
process.on('uncaughtException', (err: unknown) => {
  console.error(
    `[addon-runner CRASH] uncaughtException: ${errMsg(err)}\n${err instanceof Error ? (err.stack ?? '') : ''}`,
  )
  process.exit(1)
})
process.on('unhandledRejection', (reason: unknown) => {
  console.error(
    `[addon-runner CRASH] unhandledRejection: ${errMsg(reason)}\n${reason instanceof Error ? (reason.stack ?? '') : ''}`,
  )
})
process.on('exit', (code: number) => {
  console.error(
    `[addon-runner EXIT] code=${String(code)} nodeId=${process.env['CAMSTACK_RUNNER_ID'] ?? '?'}`,
  )
})
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => {
    console.error(
      `[addon-runner SIGNAL] received ${sig} nodeId=${process.env['CAMSTACK_RUNNER_ID'] ?? '?'}`,
    )
  })
}

// Arm this before loading or initialising any addon. A detached runner can lose
// its hub/agent parent during that boot window too; waiting until READY leaves a
// hung initialize() (and anything it spawned) orphaned forever.
startRunnerParentDeathWatchdog(() => {
  console.error(
    `[addon-runner] "${process.env['CAMSTACK_RUNNER_ID'] ?? '?'}" parent died — killing its process group`,
  )
  // On POSIX the runner is the group leader (D668), so this atomically removes
  // it and every descendant, including SIGTERM-deaf children. Under an older
  // parent or on Windows there is no owned group; retain the prior self-exit.
  if (!killOwnRunnerGroupAfterParentLoss()) process.exit(0)
})

interface RunnerAddonSpec {
  readonly addonId: string
  readonly addonDir: string
}

interface AddonPackageManifest {
  readonly addons?: readonly AddonDeclaration[]
}

interface LoadedAddon {
  readonly addonId: string
  readonly declaration: AddonDeclaration
  readonly addon: ICamstackAddon
  readonly initResult: AddonInitResult | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAddonsSpec(raw: string | undefined): readonly RunnerAddonSpec[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`[addon-runner] CAMSTACK_RUNNER_ADDONS is not valid JSON: ${errMsg(err)}`, {
      cause: err,
    })
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`[addon-runner] CAMSTACK_RUNNER_ADDONS must be a JSON array`)
  }
  const specs: RunnerAddonSpec[] = []
  for (const entry of parsed) {
    if (!isRecord(entry)) {
      throw new Error(`[addon-runner] addon spec is not an object: ${JSON.stringify(entry)}`)
    }
    const addonId = entry['addonId']
    const addonDir = entry['addonDir']
    if (typeof addonId !== 'string' || typeof addonDir !== 'string') {
      throw new Error(
        `[addon-runner] addon spec missing addonId/addonDir: ${JSON.stringify(entry)}`,
      )
    }
    specs.push({ addonId, addonDir })
  }
  return specs
}

async function loadAddonModule(
  addonId: string,
  addonDir: string,
): Promise<{
  declaration: AddonDeclaration
  mod: Record<string, unknown>
  AddonClass: new () => ICamstackAddon
}> {
  const pkgJsonPath = path.join(addonDir, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`No package.json at ${addonDir}`)
  }
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>
  const camstack = pkgJson['camstack'] as AddonPackageManifest | undefined
  const declaration = camstack?.addons?.find((a) => a.id === addonId)
  if (!declaration?.entry) {
    throw new Error(`Addon "${addonId}" not found in ${pkgJsonPath} manifest`)
  }
  const entryPath = path.resolve(addonDir, declaration.entry)
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Entry point not found: ${entryPath}`)
  }
  const modUnknown: unknown = await import(entryPath)
  const mod = isRecord(modUnknown) ? modUnknown : {}
  const AddonClass = resolveAddonClass(mod)
  if (!AddonClass) {
    throw new Error(`No addon class exported from ${entryPath}`)
  }
  return { declaration, mod, AddonClass }
}

// `buildChildCapDescriptors` lives in `./child-cap-descriptors.js` (pure,
// unit-testable — this module's `main()` runs at import time).

async function main(): Promise<void> {
  const runnerId = process.env['CAMSTACK_RUNNER_ID']
  const addonsJson = process.env['CAMSTACK_RUNNER_ADDONS']
  const parentNodeId = process.env['CAMSTACK_PARENT_NODE_ID']
  const dataDir = process.env['CAMSTACK_DATA_DIR'] ?? './camstack-data'

  if (!runnerId || !addonsJson || !parentNodeId) {
    console.error(
      '[addon-runner] Missing required env vars: CAMSTACK_RUNNER_ID, CAMSTACK_RUNNER_ADDONS, CAMSTACK_PARENT_NODE_ID',
    )
    process.exit(1)
  }

  let specs: readonly RunnerAddonSpec[]
  try {
    specs = parseAddonsSpec(addonsJson)
  } catch (err) {
    console.error(errMsg(err))
    process.exit(1)
  }

  if (specs.length === 0) {
    console.error('[addon-runner] CAMSTACK_RUNNER_ADDONS resolved to 0 addons — refusing to start')
    process.exit(1)
  }

  const nodeId = `${parentNodeId}/${runnerId}`
  // UDS endpoint is REQUIRED — there is no broker fallback after Phase F.
  // The hub/agent always propagate this when their LocalChildRegistry is
  // listening; its absence means the parent is broken, so fail fast and let
  // the supervisor surface the parent failure rather than silently hanging.
  const parentUdsPath = process.env['CAMSTACK_PARENT_UDS_PATH']
  if (!parentUdsPath) {
    console.error(
      `[addon-runner] "${nodeId}" CAMSTACK_PARENT_UDS_PATH is unset — broker-less runner cannot reach its parent. Exiting.`,
    )
    process.exit(1)
  }
  console.log(
    `[addon-runner] Starting "${nodeId}" (UDS-only) with ${specs.length} addon(s): ${specs.map((s) => s.addonId).join(', ')}`,
  )

  // Register the framework resolver BEFORE importing any addon: addons now live
  // in /data/addons (outside the framework node_modules), so their host-provided
  // imports (@camstack/system, @camstack/types, …) must be redirected to
  // CAMSTACK_FRAMEWORK_DIR. No-op in dev where workspace symlinks resolve them.
  registerFrameworkResolver(process.env['CAMSTACK_FRAMEWORK_DIR'])

  // ── Pre-load every addon module up front ───────────────────────────
  // Importing is async; doing it before the UDS connect so that any
  // module-level side effects (Python pool import readiness, model
  // registry hydration) settle before live cross-addon calls fire.
  const loadedModules: Array<{
    spec: RunnerAddonSpec
    declaration: AddonDeclaration
    AddonClass: new () => ICamstackAddon
  }> = []
  for (const spec of specs) {
    try {
      const { declaration, AddonClass } = await loadAddonModule(spec.addonId, spec.addonDir)
      loadedModules.push({ spec, declaration, AddonClass })
    } catch (err) {
      console.error(`[addon-runner] Failed to load "${spec.addonId}": ${errMsg(err)}`)
      process.exit(1)
    }
  }

  // ── Local FilesystemStorageProvider for `ctx.kernel.storage` ───────
  // Addons like `pipeline-analytics` and `analytics-suite/recording`
  // resolve filesystem paths synchronously via `ctx.kernel.storage` —
  // a sync API the storage cap can't satisfy across processes. We
  // build a local instance per addon-runner pointed at the same data
  // root the hub uses, so paths resolve identically.
  // `FilesystemStorageProvider` lives in `@camstack/types/node` (the
  // node-only sub-entry, lifted from `@camstack/system` in 2026-05 to break
  // the kernel ↔ core dependency cycle, then split off the root entry so
  // browser bundlers don't traverse `node:fs` / `node:path`).
  let storageProvider: import('@camstack/types').IStorageProvider | undefined
  let storageProviderError: unknown
  try {
    const { FilesystemStorageProvider } = await import('@camstack/types/node')
    storageProvider = new FilesystemStorageProvider(dataDir)
  } catch (err) {
    storageProviderError = err
  }

  // ── Order infra-capability providers first ─────────────────────────
  // Addons in the same runner set may call infra caps (`settings-store`,
  // `storage`, `log-destination`, `metrics-provider`) inside their
  // own `initialize()`. Sort so infra providers init first — local
  // siblings resolve via `localProviderLink`, the rest route over UDS to
  // the parent's `onUnownedCall`.
  const INFRA_CAP_NAMES = new Set([
    'settings-store',
    'storage',
    'log-destination',
    'metrics-provider',
    'platform-probe',
  ])
  /** The capability names a manifest declares, whichever form it uses. */
  const declaredCapabilityNames = (decl: AddonDeclaration): readonly string[] =>
    (decl.capabilities ?? []).map((cap) => (typeof cap === 'string' ? cap : cap.name))
  const infraPriority = (decl: AddonDeclaration): number => {
    for (const name of declaredCapabilityNames(decl)) {
      if (INFRA_CAP_NAMES.has(name)) return 0
    }
    return 1
  }
  loadedModules.sort((a, b) => infraPriority(a.declaration) - infraPriority(b.declaration))

  /** UNION manifest accumulates one entry per addon as each initialises. */
  const runnerManifest: Array<{ addonId: string; capabilities: string[] }> = []

  /**
   * Aggregated singleton (system-scoped) providers across ALL addons in this
   * runner — keyed capName → (addonId → provider). Read by the UDS child-cap
   * dispatch to resolve singleton calls (no Moleculer). The nested per-addon
   * keying matters for GROUPED runners (`execution.group`): two co-located
   * addons can register the SAME collection cap (e.g. `network-access` from
   * cloudflare-tunnel AND tailscale-ingress) — a flat capName map would keep
   * only the last-registered provider. Populated during the addon-init loop;
   * a cap-call that arrives before its addon initialises is rejected by the
   * dispatcher (the parent only routes caps the child has registered via the
   * UDS `register`/`updateCaps` handshake).
   */
  const allSingletonProviders = new Map<string, Map<string, object>>()

  /**
   * Resolve a singleton provider for the dispatcher: exact (capName, addonId)
   * match when the hint names a hosted provider, else the cap's first
   * registered provider (an unmatched `addonId` is method DATA — e.g.
   * `addons.restartAddon({ addonId })` — not a routing key).
   */
  const resolveSingletonProvider = (capName: string, addonId?: string): object | null => {
    const byAddon = allSingletonProviders.get(capName)
    if (!byAddon || byAddon.size === 0) return null
    if (addonId !== undefined) {
      const exact = byAddon.get(addonId)
      if (exact !== undefined) return exact
    }
    const first = byAddon.values().next()
    return first.done ? null : first.value
  }

  /**
   * Per-addon route-provider map — keyed by addonId → the addon's live
   * `addon-routes` provider object. Resolves `getRouteProvider(addonId)`
   * per-addon rather than returning a single global provider. Populated
   * during the init loop alongside `allSingletonProviders`.
   *
   * This is the correct abstraction even in the current single-addon-per-runner
   * policy (D2/D9): it makes the lookup honest and future-safe for any explicit
   * co-location scenario where two addons each declare `addon-routes`.
   */
  const addonRouteProviders = new Map<string, object>()

  /**
   * Per-addon HTTP data-plane endpoints — keyed by addonId → the descriptors
   * the addon's `ctx.dataPlane` facility published (via the `dataPlaneSink`
   * passed into the context). Read by the UDS `target:'data-planes'` dispatch
   * so the hub can pull them and set up its reverse-proxy. Mirrors
   * `addonRouteProviders`.
   */
  const addonDataPlanes = new Map<
    string,
    readonly import('@camstack/types').AddonDataPlaneEndpoint[]
  >()

  /**
   * Per-addon instance map — keyed by addonId → the loaded addon instance.
   * Backs the `settings` addon-call surface (`getAddonInstance`), which invokes
   * the addon's global/device settings methods. Populated during the init loop;
   * read lazily at call time (the dispatcher only fires after init completes).
   */
  const loadedAddonInstances = new Map<string, ICamstackAddon>()

  /**
   * Per-addon custom-action registry — populated during the init loop. Read by
   * the UDS addon-call dispatch to resolve `target:'custom'` calls (mirrors the
   * removed `custom.<action>` Moleculer action). Constructed up front so the
   * addon-call handler can close over it at client-construction time.
   */
  const customActionRegistry = new CustomActionRegistry()

  // Set on graceful shutdown so a late device-restore `.then()` doesn't fire a
  // doomed `updateCaps` against a closing channel (replaces the old
  // `handshakeAbort` guard).
  let shuttingDown = false

  // ── UDS child transport — connect BEFORE any addon load/init ─────────
  // CRITICAL ORDERING: addon `initialize()` issues `ctx.api` / `ctx.settings`
  // calls that route over UDS via `ipcParentLink → callOut`. There is no
  // broker fallback after Phase F, so the channel MUST be live before init.
  // The dispatch handler reads `allSingletonProviders` / `getWorkerNativeCapProvider`
  // at call time, so it resolves providers registered during the init loop
  // even though the client connected first. Pre-connect log/event buffers in
  // `LocalChildClient` flush on connect, so init-time logs survive.
  const initialCapDescriptors = buildChildCapDescriptors(
    runnerManifest,
    getWorkerNativeCapSnapshot(),
  )
  const udsChildClient = new LocalChildClient({
    nodeId: parentNodeId,
    childId: runnerId,
    caps: initialCapDescriptors,
    dispatch: createChildCapDispatch({
      getSingletonProvider: (capName, addonId) => resolveSingletonProvider(capName, addonId),
      getDeviceProvider: (capName, deviceId) =>
        getWorkerNativeCapProvider(capName, deviceId) ?? null,
      // Reproduces the hub-side `concatCollection` skip (a provider missing a
      // COLLECTION cap's array method contributes `[]`, not a "method not found").
      // Backed by the codegen'd static map so the runner never imports the
      // ~146MB schema barrel just for this predicate (D28).
      isCollectionListMethod: (capName, method) => isCollectionArrayMethodName(capName, method),
      isProviderOptionalMethod: (capName, method) => isProviderOptionalMethodName(capName, method),
    }),
  })

  // F3: serve hub→child ADDON-LEVEL calls (HTTP routes + custom actions) over
  // UDS — the two surfaces the removed per-addon Moleculer broker carried.
  // The lookups read live maps at call time (the hub only issues addon-calls
  // AFTER the child registers, by which point the init loop has populated both
  // `allSingletonProviders['addon-routes']` and `customActionRegistry`).
  // Each hosted addon's `ctx.secrets`, so a custom action's input can have the
  // secret views a form sent resolved by the OWNER (D789).
  const addonSecrets = new Map<string, SecretsAccess>()
  udsChildClient.onAddonCall(
    createChildAddonCallDispatch({
      getRouteProvider: (addonId) => addonRouteProviders.get(addonId) ?? null,
      customActions: customActionRegistry,
      getAddonInstance: (addonId) => loadedAddonInstances.get(addonId) ?? null,
      getDataPlanes: (addonId) => addonDataPlanes.get(addonId) ?? [],
      resolveSecretViews: (addonId, args) => resolveSecretViewsIn(args, addonSecrets.get(addonId)),
    }),
  )

  // Runner self-diagnostics logger — routes the addon-runner's own
  // operational lines through the UDS `log` channel (the same transport
  // every addon logger uses), so they land in the hub `LogManager` instead
  // of raw stdout. The `LocalChildClient` pre-connect buffer holds them
  // until the channel opens. Tagged with the runner id as `addonId` so the
  // hub renderer attributes runner plumbing distinctly from each hosted
  // addon's output. Pre-connect failures (missing env / bad addon spec /
  // module load) and crash handlers keep `console.*` — there is no live
  // transport at those points.
  const { logger: runnerLog, control: runnerLogControl } = createUdsLoggerWithControl(
    udsChildClient,
    runnerId,
    nodeId,
    'addon-runner',
  )

  // E2: apply the parent's `set-log-level` over UDS (mirrors the removed
  // `$node-mgmt.setLogLevel`). Tunes the runner self-logger's outbound
  // verbosity; the hub's LoggingService also filters at query time.
  udsChildClient.onSetLogLevel((level) => {
    runnerLogControl.setLevel(level)
    runnerLog.info(`Log level changed to "${level}" via UDS`)
  })

  // Connect now — the gate that replaces `broker.waitForServices('$hub')`.
  // A connect failure is fatal (no broker fallback); exit so the supervisor
  // respawns once the parent's UDS registry is back.
  try {
    await udsChildClient.start()
  } catch (err) {
    console.error(`[addon-runner] "${nodeId}" UDS connect failed — exiting: ${errMsg(err)}`)
    process.exit(1)
  }
  runnerLog.info('UDS child transport connected', { meta: { childId: runnerId } })

  // Storage-provider diagnostics — deferred until the UDS logger is live so
  // the line lands in the hub LogManager (the pre-connect buffer would have
  // held it, but the logger is built only after connect here).
  if (storageProvider) {
    runnerLog.info(`"${nodeId}" storage provider rooted at ${dataDir}`)
  } else {
    runnerLog.warn(`"${nodeId}" failed to load FilesystemStorageProvider`, {
      meta: { error: errMsg(storageProviderError) },
    })
  }

  // Re-register the child's full cap descriptor set (singletons + native
  // device-scoped caps) once an addon registers them. Idempotent atomic
  // replace; the parent re-applies via `onChildRegistered`.
  const refreshChildCaps = (reason: string, customActions?: ChildCustomActionCatalogs): void => {
    const freshDescriptors = buildChildCapDescriptors(runnerManifest, getWorkerNativeCapSnapshot())
    udsChildClient.updateCaps(freshDescriptors, customActions).catch((err: unknown) => {
      runnerLog.warn(`UDS updateCaps failed (${reason})`, {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })
  }

  // Re-publish the cap descriptor set whenever a device-scoped native cap is
  // registered (or a device is removed) AFTER the post-init handshake — async
  // providers (Reolink Baichuan discovery) register their per-camera native
  // caps as cameras come online, well after post-init. Without this, those
  // late caps stay in the worker's in-process map but never reach the hub's
  // LocalChildRegistry, so cross-process callers can't route to them (the bug
  // that left `stream-catalog` unroutable → empty broker catalog → no device-
  // settings tab). Debounced: one camera registers many caps in a burst, so we
  // coalesce into a single `updateCaps`. The timer is `unref`'d so it never
  // keeps the process alive, and cleared on shutdown.
  let capRefreshTimer: ReturnType<typeof setTimeout> | undefined
  setWorkerNativeCapsChangeListener(() => {
    if (capRefreshTimer !== undefined) return
    capRefreshTimer = setTimeout(() => {
      capRefreshTimer = undefined
      refreshChildCaps('native-cap-change')
    }, 200)
    capRefreshTimer.unref?.()
  })

  // ── Initialise each addon in declaration order ─────────────────────
  // Sequential init keeps load logs tidy and avoids surprising cross-addon
  // races during boot. The shared registry from
  // `addon-context-factory.getRegistries(nodeId)` accumulates every provider
  // so `localProviderLink` resolves siblings in-process as soon as they
  // finish initialising.
  const loaded: LoadedAddon[] = []
  // Device-restore promises — AWAITED before the post-init cap handshake so the
  // runner publishes ONE complete manifest (singletons + per-device native
  // caps) rather than a singleton-only set followed by a late device-cap
  // refresh. See the `Promise.allSettled` barrier before `refreshChildCaps`.
  const deviceRestorePromises: Array<Promise<void>> = []
  for (const { spec, declaration, AddonClass } of loadedModules) {
    try {
      const addon = new AddonClass()
      const context = await createUdsAddonContext(udsChildClient, nodeId, declaration, dataDir, {
        ...(storageProvider ? { storageProvider } : {}),
        // `ctx.dataPlane` publishes endpoints here so the hub can pull them
        // (`target:'data-planes'`) and reverse-proxy to this process's listener.
        dataPlaneSink: {
          set: (addonId, endpoints) => {
            addonDataPlanes.set(addonId, endpoints)
          },
        },
      })
      if (context.secrets !== undefined) addonSecrets.set(spec.addonId, context.secrets)
      // Lazy native-deps install: an addon dir swapped in by a
      // LifecycleJob update has no node_modules/<native> yet. Installing here, in
      // the addon's OWN process, keeps the hub responsive and the update fast.
      // Idempotent via the .camstack-native-deps-installed marker; no-op for
      // pure-JS addons. Failures are fatal to THIS runner only (the addon needs
      // its native to run) — the supervisor surfaces it.
      try {
        const pkgRaw = JSON.parse(
          fs.readFileSync(path.join(spec.addonDir, 'package.json'), 'utf-8'),
        ) as Record<string, unknown>
        await installManifestNativeDeps(spec.addonDir, pkgRaw, context.logger)
      } catch (nativeErr) {
        console.error(
          `[addon-runner] native deps install failed for "${spec.addonId}": ${errMsg(nativeErr)}`,
        )
        process.exit(1)
      }
      // Manifest-driven Python deps — installs `python.requirements`
      // declared in the addon's package.json before `onInitialize()`
      // runs. Idempotent across boots via marker hashing.
      await installManifestPythonDeps(declaration, spec.addonDir, context.deps, context.logger)
      // Manifest-driven host binaries — same declaration site, same position
      // in the lifecycle (before `onInitialize()`, so no capability advertises
      // itself while the binary it wraps is missing). Never fatal: a failure
      // warns and the owning capability refuses on its own surface, because
      // aborting here would take this runner's SIBLING addons down with it.
      await installManifestSystemDeps(declaration, context.logger)
      const registeredProviders = new Map<string, unknown>()
      // The manifest publishes only AFTER this await returns (see the
      // post-init handshake below), so an `initialize()` that does not return
      // takes every capability this addon owns off the cluster — silently, on
      // a process that keeps logging as if it were healthy. The watchdog is
      // the line that says so. See `init-watchdog.ts` for the incident.
      const initWatchdog = startInitWatchdog({
        addonId: spec.addonId,
        declaredCapabilities: declaredCapabilityNames(declaration),
        warn: (message, meta) => {
          runnerLog.warn(message, { meta })
        },
      })
      let initResult: AddonInitResult | void
      try {
        initResult = normalizeAddonInitResult(await addon.initialize(context))
      } finally {
        initWatchdog.clear()
      }

      for (const reg of initResult?.providers ?? []) {
        const capName = reg.capability.name
        registeredProviders.set(capName, reg.provider)
        context.registerProvider(capName, reg.provider)
        // Accumulate into the runner-wide singleton provider map for UDS dispatch.
        // Store only plain objects (providers); the dispatcher resolves methods
        // structurally via a type guard, so no cast is needed here.
        const prov = reg.provider
        if (prov !== null && typeof prov === 'object' && !Array.isArray(prov)) {
          const byAddon = allSingletonProviders.get(capName) ?? new Map<string, object>()
          byAddon.set(spec.addonId, prov)
          allSingletonProviders.set(capName, byAddon)
          // Also track addon-routes providers per-addonId so the dispatch
          // resolves the CORRECT provider when `getRouteProvider(addonId)` is
          // called — not a single global winner that ignores the argument.
          if (capName === 'addon-routes') {
            addonRouteProviders.set(spec.addonId, prov)
          }
        }
      }

      if (initResult?.customActions && initResult.actionHandlers) {
        const handlers = initResult.actionHandlers
        customActionRegistry.registerAddon(
          spec.addonId,
          initResult.customActions,
          (action, input, caller) => {
            const fn = handlers[action]
            if (!fn) {
              throw new Error(
                `addon '${spec.addonId}' has no handler for custom action '${action}'`,
              )
            }
            return fn(input, caller)
          },
        )
      }

      validateProviderRegistrations(spec.addonId, declaration, registeredProviders, context.logger)

      // No Moleculer service to mount (UDS-only): singleton caps dispatch via
      // `allSingletonProviders`, device-scoped caps via `getWorkerNativeCapProvider`,
      // both over UDS. `createChildCapDispatch` resolves methods structurally,
      // so the `createAddonService` schema / method+timeout resolvers are gone.
      const capNames = [...registeredProviders.keys()]
      context.logger.info(
        `"${spec.addonId}" caps: ${capNames.length > 0 ? capNames.join(', ') : '(none)'}`,
      )

      // Accumulate this addon's cap names into the UNION manifest.
      runnerManifest.push({
        addonId: spec.addonId,
        capabilities: capNames,
      })

      // Queue device restore. Provider addons (provider-rtsp, provider-reolink,
      // …) rely on this to rehydrate their IDevice registry from the hub's
      // `device-manager` cap; restoring a device runs `registerNativeCap` for
      // its per-device caps. We DON'T fire-and-forget + late-refresh anymore —
      // that published the singleton-only manifest first, so a hot-reload's
      // `restartAddon` waitForProvider resolved on singletons while per-device
      // caps were still registering (the `no-provider` window). Instead we
      // collect the promise and await all restores before the SINGLE post-init
      // handshake, so the complete manifest publishes atomically.
      if (typeof (addon as { restoreDevices?: unknown }).restoreDevices === 'function') {
        deviceRestorePromises.push(
          runWorkerDeviceRestoreWithRetry(
            addon,
            context as Parameters<typeof runWorkerDeviceRestoreWithRetry>[1],
            spec.addonId,
            nodeId,
          ),
        )
      }

      addon.postBrokerStart()
      loadedAddonInstances.set(spec.addonId, addon)
      loaded.push({
        addonId: spec.addonId,
        declaration,
        addon,
        initResult: initResult ?? null,
      })
    } catch (err) {
      // Raw console: an init failure is fatal and `process.exit(1)` fires
      // synchronously — an async UDS log would never flush. The supervisor
      // restarts the runner on the non-zero exit.
      console.error(`[addon-runner] Init failed for "${spec.addonId}": ${errMsg(err)}`)
      // A typed refusal (D877) is not a crash: say so to the parent, in a form
      // that survives the exit (sync write), and leave with the refusal code so
      // the breaker does not count it.
      const refusal = findAddonRefusal(err)
      if (refusal !== null) {
        try {
          fs.writeSync(1, formatRunnerRefusalLine(nodeId, refusalReportOf(spec.addonId, refusal)))
        } catch {
          // The exit code below still classifies this exit as a refusal.
        }
        process.exit(RUNNER_REFUSED_EXIT_CODE)
      }
      process.exit(1)
    }
  }

  // ── Device-restore barrier ─────────────────────────────────────────
  // Wait for EVERY hosted addon's device restore to finish before the first
  // cap handshake. Device restore is what runs `registerNativeCap` for each
  // restored device's per-device caps; publishing before it completes would
  // advertise a singleton-only manifest, and a hot-reload's `restartAddon`
  // (which waits on the manifest's declared/singleton caps) would treat the
  // restart as done while per-device caps were still missing — the
  // `no-provider` window. `allSettled` so one camera that fails to restore
  // can't block the node's registration; the complete set still publishes.
  // The invariant: a node sends its COMPLETE manifest once boot finishes.
  if (deviceRestorePromises.length > 0 && !shuttingDown) {
    await Promise.allSettled(deviceRestorePromises)
  }

  // ── UDS registration handshake ─────────────────────────────────────
  // Every addon in the runner set is initialised AND every device restored.
  // Register the COMPLETE cap descriptor set (singletons + device-scoped native
  // caps) over UDS — this IS the handshake (the parent applies it via
  // `onChildRegistered`, mirroring the removed `$hub.registerNode` RPC).
  // Idempotent atomic replace of the child's cap set.
  //
  // The custom-action catalogs ride THIS frame, schemas stripped: they exist
  // only now that every `initialize()` has returned, and this is the one
  // register the parent is guaranteed to receive after that. The hub used to
  // learn them by evaluating the addon's bundle inside hub-main (D444).
  refreshChildCaps('post-init', customActionRegistry.describeAll(specs.map((spec) => spec.addonId)))

  // ── Hub reachability + reconnect re-register ────────────────────────
  // The UDS connect IS parent reachability. `onConnected` fires on the
  // initial connect (already happened above) AND on every reconnect after a
  // parent-side restart. On (re)connect: re-register the cap set (idempotent
  // handshake) and fire each addon's `onHubReachable` exactly once. Kept
  // symmetrical with the prior broker `$node.connected` semantics.
  let hubReachableFired = false
  const fireHubReachableOnce = (): void => {
    if (hubReachableFired) return
    hubReachableFired = true
    for (const entry of loaded) {
      if (typeof entry.addon.onHubReachable === 'function') {
        Promise.resolve(entry.addon.onHubReachable()).catch((err: unknown) => {
          runnerLog.error(`"${entry.addonId}" onHubReachable() threw`, {
            meta: { error: errMsg(err) },
          })
        })
      }
    }
  }
  udsChildClient.onConnected(() => {
    // Reconnect (after a parent restart) — re-register the full cap set so the
    // parent re-applies the manifest; the initial connect already registered
    // `initialCapDescriptors` during `start()`.
    if (hubReachableFired) refreshChildCaps('on reconnect')
    fireHubReachableOnce()
  })
  // The initial connect fired before `onConnected` was registered, so trigger
  // the one-shot `onHubReachable` directly for the addons loaded this boot.
  fireHubReachableOnce()

  runnerLog.info(`"${nodeId}" started — ${loaded.length} addon(s) ready (UDS connected)`)
  process.stdout.write(`READY:${nodeId}\n`)

  // ── Heavy-runner heap watch + stranded-page reclaim ────────────────
  // Heavy runners (recorder, stream-broker, …) now all carry an old-space
  // ceiling, but a ceiling is not what returns the pages: most of what strands
  // in these processes is NATIVE — `external`, `arrayBuffers`, glibc arena free
  // lists — and `--max-old-space-size` bounds none of it. Measured 2026-08-25,
  // `hub/pipeline-analytics` stranded 2552MB while its V8 heap held 81MB. This
  // is hub-main's proven reclaimer (11 live passes in 4h, 375–1652MB returned
  // each), gated on the same stranded-over-trigger condition, so a quiet runner
  // never pays a pass. Light runners start nothing. See `startRunnerHeapWatch`
  // for the pricing of the sub-second stall on a runner that finalizes segments.
  const stopHeapWatch = startRunnerHeapWatch({
    heapProfile: process.env['CAMSTACK_RUNNER_HEAP_PROFILE'],
    reclaimSwitch: process.env['CAMSTACK_RUNNER_HEAP_RECLAIM'],
    // The whole-process RSS budget the parent resolved from the co-located manifests. Absent
    // means no addon here declared one, and the runner says so at boot rather than running with
    // an invented default — the ceiling and the reclaim gate are both blind to `external`, which
    // is 96% of what OOM-killed `hub/pipeline-analytics` at 11.4GB on 2026-08-27.
    rssBudgetMb: process.env[RUNNER_RSS_BUDGET_ENV],
    label: nodeId,
    sink: {
      info: (line) => {
        runnerLog.info(line)
      },
      warn: (line) => {
        runnerLog.warn(line)
      },
    },
  })

  // ── Diagnostic: SIGUSR2 logs a per-addon memory report + the FULL per-space
  // breakdown (inspector-free; the inherited --inspect on the shared port 9229
  // makes CDP probes hit the wrong process). Collect with `kill -USR2 <pid>`
  // then read the log.
  //
  // The snapshot used to ride on the same signal, and that weld was the bug.
  // `v8.getHeapSpaceStatistics()` is ~1.2 µs and changes nothing;
  // `v8.writeHeapSnapshot` is a multi-GB write and a stop-the-world walk of the
  // heap — an admin mutation on a production hub. Welded, the free answer to
  // "is it millions of small objects or a handful of huge ones" could only be
  // had by also taking the expensive one nobody had authorised, so for the six
  // months this handler existed it was never fired on the process that needed
  // it. The snapshot is gone entirely (D718) — it took the hub down twice — and
  // the signal now reports the breakdown only. See `emitHeapDiagnosticReport`.
  //
  // The same breakdown now also rides the periodic `[mem]` heartbeat
  // (`formatHeapSpaces`), so the routine case needs no signal at all; this
  // handler stays for the unfiltered, 0.1MB-resolution read of every space.
  process.on('SIGUSR2', () => {
    emitHeapDiagnosticReport({
      label: nodeId,
      addons: loaded.map((e) => e.addonId),
      sink: {
        info: (line) => {
          runnerLog.info(line)
        },
        warn: (line) => {
          runnerLog.warn(line)
        },
      },
    })
  })

  // ── Graceful shutdown ──────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    // Idempotent: a runner leads its own process group (D668), so hub-main's group
    // SIGTERM and `$process`'s own SIGTERM can both land. One shutdown, not two
    // interleaved `addon.shutdown()` passes.
    if (shuttingDown) return
    shuttingDown = true
    stopHeapWatch?.()
    // Stop reacting to native-cap changes + cancel any pending debounce so a
    // late registration during teardown can't fire `updateCaps` on a closing
    // channel.
    setWorkerNativeCapsChangeListener(null)
    if (capRefreshTimer !== undefined) {
      clearTimeout(capRefreshTimer)
      capRefreshTimer = undefined
    }
    runnerLog.info(`"${nodeId}" shutting down ${loaded.length} addon(s)...`)
    for (const entry of loaded) {
      try {
        await entry.addon.shutdown()
      } catch (err) {
        runnerLog.error(`"${entry.addonId}" shutdown threw`, {
          meta: { error: errMsg(err) },
        })
      }
    }
    try {
      await udsChildClient.close()
    } catch (err) {
      runnerLog.warn('UDS child transport close threw during shutdown', {
        meta: { error: errMsg(err) },
      })
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => {
    void shutdown()
  })
  process.on('SIGINT', () => {
    void shutdown()
  })
}

main().catch((err: unknown) => {
  console.error(`[addon-runner] Fatal error: ${errMsg(err)}`)
  process.exit(1)
})
