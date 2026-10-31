/**
 * AgentUpdateService — agent-side adapter over the SHARED `RootUpdateService`
 * (`@camstack/node-root`, bundled into the `@camstack/server` dist by tsup).
 * Post-consolidation the agent boots the SAME `@camstack/server` closure as
 * the hub (via `CAMSTACK_ROLE=agent`), so this service stages/applies
 * `@camstack/server` closures in `<agentDataDir>/server-root/`, applied on
 * restart by the shared STARTER (single-copy in-place swap — no probation,
 * no auto-rollback).
 *
 * The engine lives in the shared core; this module binds the agent's
 * parameters, which differ from the hub only in the RESTART seam:
 *   - spec `@camstack/server` + `dist/launcher.js` (the single root spec)
 *   - env markers `CAMSTACK_SERVER_{BOOT_MODE,ACTIVE_VERSION}` +
 *     `CAMSTACK_SEED_SERVER_DIR` (written by the shared starter / image) —
 *     identical to the hub, because the on-disk root is `@camstack/server`
 *   - restart = graceful self-SIGTERM → the supervisor (docker restart
 *     policy / Electron main) relaunches → the shared starter swaps the copy
 *   - confirmBootHealthy = the agent's `$hub.registerNode` reaching its
 *     acked state (wired in main.ts) — a single-copy GC sweep, no promotion
 *
 * Spec: docs/superpowers/specs/2026-07-18-single-framework-copy-collapse-design.md
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RegisteredAddonManifest } from '@camstack/system'
import { readPendingRestart, writePendingRestart } from '@camstack/system'
import type {
  IEventBus,
  IScopedLogger,
  PendingRestartMarkerPayload,
  RunnerBootCheck,
} from '@camstack/types'
import { EventCategory } from '@camstack/types'
import {
  buildSystemEnsureNativePrebuilds,
  type EnsureNativePrebuildsFn,
} from '../core/server-update/system-ensure-prebuilds.js'
import {
  buildSystemApplyClosurePatches,
  type ApplyClosurePatchesFn,
} from '../core/server-update/system-apply-closure-patches.js'
import { buildSystemExecNpm } from '../core/server-update/system-exec-npm.js'
import { UpdateAvailabilityEmitter } from '../core/update-availability-emitter.js'
import type { IUpdateAvailabilityStore } from '../core/update-availability-store.js'
import { FileUpdateAvailabilityStore } from '../core/update-availability-store.js'
import {
  ELECTRON_APP_VERSION_ENV,
  HUB_ROOT_SPEC,
  type NpmExecFn,
  type RootRestartUpdate,
  type RootUpdateLogger,
  RootUpdateService,
  serverRootDir,
  type WrapperProbeReadings,
  writeRestartIntentMarker,
} from '../server-root/index.js'
import {
  announceProductVersionChange,
  buildNodeUpdateAnnouncement,
} from '../core/updates/node-update-announcement.js'
import { buildRestartMarker } from '../core/updates/restart-marker.js'
import { killSelfHard } from './agent-shutdown.js'

/**
 * The synthetic addonId the agent's OWN runtime registers infra providers
 * under (no addon owns them — the bootstrap does). Appears in the agent's
 * `$hub.registerNode` manifest so the hub's cap routing can reach the
 * agent-hosted `server-management` provider via `nodeId` pinning.
 */
export const AGENT_RUNTIME_ADDON_ID = 'agent-runtime'

/** Grace before the self-SIGTERM so the tRPC reply can flush to the hub. */
export const AGENT_RESTART_GRACE_MS = 2_000

/**
 * Best-effort container detection for the restart-policy startup warning
 * (security review #3). `/.dockerenv` is present in Docker/Podman containers;
 * this is diagnostic only — never gates any logic.
 */
export function isRunningInContainer(existsSyncFn: (p: string) => boolean): boolean {
  return existsSyncFn('/.dockerenv')
}

/**
 * Resolve the RUNNING root (`@camstack/server`) package.json. The agent boots
 * the same `@camstack/server` closure as the hub, whose dist lives at
 * `<pkg>/dist/*.js`, so `../package.json` is the normal hit; the second
 * candidate covers a nested layout.
 */
export function resolveAgentPackageJsonPath(fromDir: string): string {
  const candidates = [
    path.resolve(fromDir, '..', 'package.json'),
    path.resolve(fromDir, '..', '..', 'package.json'),
  ]
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { name?: string }
      if (raw.name === HUB_ROOT_SPEC.packageName) return candidate
    } catch {
      /* keep searching */
    }
  }
  return candidates[0] ?? path.resolve(fromDir, '..', 'package.json')
}

/**
 * Default restart seam: log, then after a short grace self-deliver SIGTERM so
 * the bootstrap's graceful shutdown runs (addons stopped, broker stopped,
 * exit 0) and the container restart policy relaunches into the starter. A
 * hard exit fallback guards against a wedged shutdown.
 *
 * When `dataDir` is given, drop a restart-intent MARKER in the server-root dir
 * BEFORE the SIGTERM so an external process supervisor (phase 3: the Electron
 * shell) can tell this INTENTIONAL update/rollback restart apart from a crash
 * and not penalise its crash-backoff. The docker restart policy ignores the
 * marker (it relaunches regardless), so this is a no-op there. Best-effort: a
 * marker-write failure must never block the restart.
 */
export function scheduleAgentRestart(
  logger: RootUpdateLogger,
  requestedBy: string,
  dataDir?: string,
): void {
  if (dataDir !== undefined && dataDir.length > 0) {
    try {
      writeRestartIntentMarker(serverRootDir(dataDir), {
        requestedAtMs: Date.now(),
        reason: requestedBy,
      })
    } catch (err) {
      logger.warn('failed to write restart-intent marker', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
  logger.warn('agent restart requested — exiting for supervisor relaunch', {
    meta: { requestedBy, graceMs: AGENT_RESTART_GRACE_MS },
  })
  const grace = setTimeout(() => {
    process.kill(process.pid, 'SIGTERM')
    const hard = setTimeout(
      () => killSelfHard('agent restart: shutdown did not finish in 15000ms; SIGKILL'),
      15_000,
    )
    hard.unref()
  }, AGENT_RESTART_GRACE_MS)
  grace.unref()
}

export interface AgentUpdateServiceOptions {
  /**
   * Full scoped logger — an `IScopedLogger` (satisfies the engine's structural
   * `RootUpdateLogger`) so the injected runNpm-backed `execNpm` can pass it to
   * `runNpm` (which needs `child`/`withTags`).
   */
  readonly logger: IScopedLogger
  /** The agent's resolved data dir (config.dataDir). */
  readonly dataDir: string
  /** Overrides for tests. */
  readonly restartAgent?: (requestedBy: string) => void
  readonly execNpm?: NpmExecFn
  readonly ensureNativePrebuilds?: EnsureNativePrebuildsFn
  readonly applyClosurePatches?: ApplyClosurePatchesFn
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => number
  readonly runningPackageJsonPath?: string
  readonly eventBus?: IEventBus
  readonly nodeId?: string
  /**
   * Durable dedup state for `update.available`. Omitted in tests; the agent
   * runtime lets `bindAvailability` derive a file store from its data dir.
   */
  readonly updateAvailabilityStore?: IUpdateAvailabilityStore
  /** The agent's runner boot check (D877), served on the status. */
  readonly runnerBootCheck?: () => RunnerBootCheck | undefined
  /** Container probes (test override) — see `RootUpdateServiceOptions.readWrapperProbes`. */
  readonly readWrapperProbes?: () => WrapperProbeReadings
}

/**
 * The agent's restart ANNOUNCEMENT (D723): `system.restarting`, emitted before
 * the self-SIGTERM, through the agent's event bus — which broadcasts it to the
 * hub, where the notification centre turns it into `node-restarting` or
 * `node-updating`. Until D723 the agent emitted nothing before exiting, so an
 * agent's restart was announced only after the fact (`system.restart-completed`).
 *
 * Its own small object because the restart seam is a closure handed to the base
 * class BEFORE `this` exists, while the bus is bound later (`bindAvailability`,
 * once the mesh is up). A restart before that has nobody to tell — said, never
 * silent.
 */
export class AgentRestartAnnouncer {
  private eventBus: IEventBus | null
  private nodeId: string

  constructor(
    private readonly logger: IScopedLogger,
    eventBus: IEventBus | null,
    nodeId: string,
  ) {
    this.eventBus = eventBus
    this.nodeId = nodeId
  }

  bind(eventBus: IEventBus, nodeId: string): void {
    this.eventBus = eventBus
    this.nodeId = nodeId
  }

  announce(marker: PendingRestartMarkerPayload): void {
    const bus = this.eventBus
    if (bus === null) {
      this.logger.warn('agent restart NOT announced — the event bus is not bound yet', {
        meta: { nodeId: this.nodeId, kind: marker.kind },
      })
      return
    }
    const payload: PendingRestartMarkerPayload = { ...marker, nodeId: this.nodeId }
    try {
      bus.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'core', id: 'agent-update-service' },
        category: EventCategory.SystemRestarting,
        data: payload,
      })
    } catch (err) {
      // Telemetry (D8): an announcement that could not go out must never block
      // the restart it announces.
      this.logger.warn('agent restart announcement failed', {
        meta: { nodeId: this.nodeId, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}

export class AgentUpdateService extends RootUpdateService {
  private readonly restartAnnouncer: AgentRestartAnnouncer
  private updateAvailability: UpdateAvailabilityEmitter | null
  private eventBus: IEventBus | null
  private nodeId: string
  private readonly agentDataDir: string
  /** The base class keeps `logger` private; hold our own for the store. */
  private readonly agentLogger: IScopedLogger

  constructor(options: AgentUpdateServiceOptions) {
    const restartAgent =
      options.restartAgent ??
      ((requestedBy): void => scheduleAgentRestart(options.logger, requestedBy, options.dataDir))
    // Resolved before `super` so the base class stamps `tags.nodeId` on every
    // line. `bindAvailability` can re-point `this.nodeId` later once the hub
    // handshake settles the id; the log tag keeps the boot-time value, which is
    // the same string in every deployment that sets `CAMSTACK_NODE_ID`.
    const nodeId = options.nodeId ?? process.env['CAMSTACK_NODE_ID'] ?? 'agent'
    const restartAnnouncer = new AgentRestartAnnouncer(
      options.logger,
      options.eventBus ?? null,
      nodeId,
    )
    super({
      spec: HUB_ROOT_SPEC,
      nodeId,
      // The agent's on-disk root IS `@camstack/server` (booted via
      // CAMSTACK_ROLE=agent by the shared starter), so it reads the SAME
      // `CAMSTACK_SERVER_*` boot markers the starter writes.
      envNames: {
        bootMode: 'CAMSTACK_SERVER_BOOT_MODE',
        activeVersion: 'CAMSTACK_SERVER_ACTIVE_VERSION',
        seedDir: 'CAMSTACK_SEED_SERVER_DIR',
      },
      logger: options.logger,
      restartServer: (requestedBy, update): void => {
        const marker = writeAgentRestartMarker(options.dataDir, requestedBy, update)
        restartAnnouncer.announce(marker)
        restartAgent(requestedBy)
      },
      dataDir: options.dataDir,
      runningPackageJsonPath:
        options.runningPackageJsonPath ?? resolveAgentPackageJsonPath(__dirname),
      workspaceProbeDir: __dirname,
      // Default to the runNpm-backed adapter — a packaged desktop agent ships a
      // bare Node with no system npm, so the raw `execFile('npm')` default would
      // ENOENT. `cacheDir` mirrors AddonInstaller's `<dataDir>/addons/.npm-bootstrap`.
      execNpm:
        options.execNpm ??
        buildSystemExecNpm({
          cacheDir: path.join(options.dataDir, 'addons', '.npm-bootstrap'),
          logger: options.logger,
        }),
      // Same native-prebuild ensure step as the hub — a packaged desktop AGENT
      // ships the identical bare Node, so its `applyServerUpdate` staging would
      // hit the same source-only `better-sqlite3` miss without this.
      ensureNativePrebuilds:
        options.ensureNativePrebuilds ?? buildSystemEnsureNativePrebuilds(options.logger),
      // Apply the closure patches ourselves. npm 12 blocks the root package's
      // postinstall by default, and a silently-unpatched closure is refused by
      // the validator — an update that can never apply. Idempotent, so this
      // costs nothing where npm did run the lifecycle.
      applyClosurePatches:
        options.applyClosurePatches ?? buildSystemApplyClosurePatches(options.logger),
      env: options.env,
      now: options.now,
      ...(options.readWrapperProbes !== undefined
        ? { readWrapperProbes: options.readWrapperProbes }
        : {}),
      // The shell is about to replace itself, and this node with it: announce
      // it through the same announcer a restart uses (D723), before the install.
      onDesktopInstallRequested: (info) =>
        restartAnnouncer.announce(
          buildNodeUpdateAnnouncement({
            what: 'desktop-shell',
            fromVersion: info.fromVersion,
            ...(info.toVersion !== null ? { toVersion: info.toVersion } : {}),
            requestedAt: Date.now(),
          }),
        ),
      ...(options.runnerBootCheck !== undefined
        ? { runnerBootCheck: options.runnerBootCheck }
        : {}),
    })
    this.nodeId = nodeId
    this.restartAnnouncer = restartAnnouncer
    this.agentDataDir = options.dataDir
    this.agentLogger = options.logger
    this.eventBus = options.eventBus ?? null
    this.updateAvailability =
      options.eventBus !== undefined
        ? new UpdateAvailabilityEmitter(
            options.eventBus,
            { type: 'core', id: 'agent-update-service' },
            options.updateAvailabilityStore,
          )
        : null
  }

  /**
   * Bind the agent's real event bus once the mesh is up. The dedup state is
   * persisted under the agent's data dir from here on — an agent restarts on
   * every root update, which is exactly when its availability list is longest.
   */
  bindAvailability(eventBus: IEventBus, nodeId: string): void {
    this.eventBus = eventBus
    this.nodeId = nodeId
    this.restartAnnouncer.bind(eventBus, nodeId)
    this.updateAvailability = new UpdateAvailabilityEmitter(
      eventBus,
      { type: 'core', id: 'agent-update-service' },
      new FileUpdateAvailabilityStore(this.agentDataDir, 'agent-update', this.agentLogger),
    )
  }

  override async checkServerUpdate() {
    const result = await super.checkServerUpdate()
    if (result.error !== null) return result
    this.updateAvailability?.publishSnapshot(
      'server',
      result.updateAvailable && result.runningVersion !== null && result.latestVersion !== null
        ? [
            {
              target: 'server',
              packageName: result.packageName,
              currentVersion: result.runningVersion,
              latestVersion: result.latestVersion,
              nodeId: this.nodeId,
            },
          ]
        : [],
      this.nodeId,
    )
    return result
  }

  /**
   * Boot-time: a container that came up on a different image than its previous
   * boot announces it as a `node-updating` (see `node-update-announcement.ts`).
   * A no-op until the bus is bound — the caller runs it from the first acked
   * registration, where the bus is.
   */
  announceImageChangeIfAny(productVersion: string | null, env: NodeJS.ProcessEnv): void {
    const bus = this.eventBus
    if (bus === null) return
    announceProductVersionChange({
      dataDir: this.agentDataDir,
      productVersion,
      underDesktopShell: (env[ELECTRON_APP_VERSION_ENV] ?? '').length > 0,
      bus,
      sourceId: 'agent-update-service',
      nodeId: this.nodeId,
      logger: this.agentLogger,
    })
  }

  /** Consume `.restart-pending` and emit `system.restart-completed` if present. */
  emitRestartCompletedIfPending(): void {
    const bus = this.eventBus
    if (bus === null) return
    const marker = readPendingRestart(this.agentDataDir)
    if (marker === null) return
    const payload: PendingRestartMarkerPayload = {
      kind: marker.kind,
      requestedAt: marker.requestedAt,
      nodeId: this.nodeId,
      ...(marker.packageName !== undefined ? { packageName: marker.packageName } : {}),
      ...(marker.fromVersion !== undefined ? { fromVersion: marker.fromVersion } : {}),
      ...(marker.toVersion !== undefined ? { toVersion: marker.toVersion } : {}),
      ...(marker.requestedBy !== undefined ? { requestedBy: marker.requestedBy } : {}),
    }
    bus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'core', id: 'agent-update-service' },
      category: EventCategory.SystemRestartCompleted,
      data: payload,
    })
  }
}

/** Write the marker and return it — the same payload is the announcement (D723). */
function writeAgentRestartMarker(
  dataDir: string,
  requestedBy: string,
  update?: RootRestartUpdate,
): PendingRestartMarkerPayload {
  // Same builder as the hub: an agent's "Server aggiornato" notification must
  // name both versions too — see `core/updates/restart-marker.ts`.
  const marker = buildRestartMarker({
    requestedAt: Date.now(),
    requestedBy,
    ...(update !== undefined ? { update } : {}),
  })
  try {
    writePendingRestart(dataDir, marker)
  } catch {
    // Marker write must never block the restart.
  }
  return marker
}

/**
 * The manifest entry for the agent runtime's own providers. Appended to
 * `buildAgentOwnManifest`'s output so `server-management` reaches the hub's
 * `HubNodeRegistry` (and therefore `createCapabilityProxy` node routing) even
 * though no `loadedAddons` entry owns it.
 */
export function agentRuntimeManifestEntry(): RegisteredAddonManifest {
  return {
    addonId: AGENT_RUNTIME_ADDON_ID,
    capabilities: ['server-management', 'node-certificates'],
  }
}
