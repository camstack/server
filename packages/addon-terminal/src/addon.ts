/**
 * Terminal addon — hosts interactive pty sessions running an allowlisted
 * profile (`monitor` → `btm`), streamed to the Admin UI over the data plane.
 *
 * Phase 1 of docs/design/2026-07-26-terminal-session-design.md: a real TTY good
 * enough to run a full-screen program. Phase 2 (streaming a session as a camera)
 * is a separate device-provider concern and does not change this addon's cap.
 *
 * Its own package (not a builtin) because it carries a native dependency
 * (`node-pty`) and should update via `dominevo deploy` independently of the
 * framework, exactly like the node-av decoder addon.
 */

import { execFile } from 'node:child_process'
import type { AddonDataPlaneHandle, AddonInitResult, ConfigUISchema } from '@dominevo/types'
import {
  BaseAddon,
  bareAddonId,
  COMPOSER_ADDON_ID,
  declarationOwnerNodeId,
  errMsg,
  integrationInstancesCapability,
  nodePin,
  type InstanceChange,
  RecordIntegrationInstances,
  legacySweepDone,
  sweepLegacyEngineRows,
  terminalSessionCapability,
} from '@dominevo/types'
import { cursesShimDir, cursesShimDirExists, resolveGlancesCursesShimEnv } from './curses-shim.js'
import { sanitizeProfileSettings, spawnArgsForInstance } from './profile-settings.js'
import { ADDON_MIGRATIONS, INSTANCES_TO_RECORDS_ID, terminalPortsOver } from './migrations/index.js'
import { createNodePtySpawner, resolveExecutable, warmNodePty } from './pty.js'
import {
  hostLooksLikeContainer,
  resolveServerShell,
  SERVER_SHELL_IDLE_DEFAULT_MINUTES,
  SERVER_SHELL_PROFILE_ID,
  serverShellIdleMs,
  serverShellOptIn,
} from './server-shell.js'
import { silenceAnalysisFor } from './silence-analysis.js'
import { installTerminalCameraRelay } from './terminal-camera-device.js'
import { gatedTerminalCameraPass, TerminalCameraHost } from './terminal-camera-host.js'
import { TerminalCameraRelay } from './terminal-camera-relay.js'
import { createTerminalDataPlaneHandler } from './terminal-data-plane.js'
import {
  isTerminalBodyConfigured,
  instancesOnAbsentNodes,
  rawInstanceOfRecord,
  readTerminalInstances,
  type TerminalInstance,
  TerminalInstanceMutationQueue,
  TerminalInstanceReconcileCoordinator,
} from './terminal-instances.js'
import { AbsentNodeAlerts, type AbsentNodeEntry } from './terminal-absent-nodes.js'
import { TerminalSessionManager } from './terminal-session-manager.js'
import {
  initialTerminalBody,
  type TerminalBody,
  TERMINAL_INSTANCES_KIND_NAME,
  TerminalBodySchema,
  terminalInstancesKind,
} from './terminal-record-kinds.js'
import { createXtermScreen } from './xterm-screen.js'

/**
 * Default argv for the Glances profile — deliberately EMPTY.
 *
 * Measured on the hub (2026-08-21, glances 4.5.6, embedded Python, a real pty
 * at the terminal camera's own 120x40 grid, CPU sampled from
 * /proc/<pid>/{utime,stime} so the number is the process's own and not the
 * box's contention):
 *
 *   argv                                                 CPU (of one core)
 *   (none — this default)                                0.8 %
 *   -t 3                                                 0.7 %
 *   -t 5                                                 0.6 %
 *   --disable-plugin processlist                         0.7 %
 *   --disable-plugin containers                          0.9 %
 *   --disable-plugin sensors                             0.8 %
 *   --disable-process                                    0.8 %
 *   -t 3 --disable-plugin processlist,containers,sensors 0.5 %
 *   -t 5 --disable-plugin processlist,containers,sensors 0.4 %
 *
 * Startup costs 0.19 core-seconds; steady state is 1.0 % of one core at 36 MB
 * RSS. The whole tuning range is worth ~0.4 % of ONE core out of 20 — below the
 * noise floor of a box that idles at 2.6 cores — while every entry that buys
 * something removes a panel the operator opened the camera to read. `-t` is
 * additionally counter-productive here: the terminal camera renders at 2 FPS
 * and glances already repaints every 2 s, so slowing glances only makes the
 * camera show stale numbers.
 *
 * So the default ships empty and the knob stays in front of the operator.
 * Anyone who does want to trade panels for CPU has the numbers above.
 */
const DEFAULT_GLANCES_ARGS: readonly string[] = []

const GLANCES_ARGS_DESCRIPTION =
  'Exact arguments passed to Glances. One tag per argv entry. Empty is the measured-best default: at the camera grid Glances costs ~1% of one core, and the cheapest tuning found (`-t 5 --disable-plugin processlist,containers,sensors`) saves only ~0.4% of one core while removing the panels most people open it for. `-t` also makes the camera show stale numbers — it renders at 2 FPS and Glances already repaints every 2s.'

interface TerminalAddonConfig {
  readonly btmPath: string
  readonly btmEnabled: boolean
  readonly btmArgs: readonly string[]
  readonly topEnabled: boolean
  readonly topPath: string
  readonly topArgs: readonly string[]
  readonly glancesEnabled: boolean
  readonly glancesPath: string
  readonly glancesArgs: readonly string[]
  readonly allowShell: boolean
  readonly shellPath: string
  readonly serverShellEnabled: boolean
  readonly serverShellIdleMinutes: number
  readonly maxSessions: number
  readonly customProfiles: readonly Record<string, unknown>[]
}

const DEFAULTS: TerminalAddonConfig = {
  btmPath: '',
  btmEnabled: true,
  btmArgs: [],
  topEnabled: true,
  topPath: '',
  topArgs: [],
  glancesEnabled: true,
  glancesPath: '',
  glancesArgs: DEFAULT_GLANCES_ARGS,
  allowShell: false,
  shellPath: '',
  serverShellEnabled: false,
  serverShellIdleMinutes: SERVER_SHELL_IDLE_DEFAULT_MINUTES,
  maxSessions: 4,
  customProfiles: [],
}

const DATA_PLANE_PREFIX = 'io'
const CAMERA_RECONCILE_MS = 60_000
/** The integration the Terminal cameras were declared under before they were blocks (planning#580). */
const LEGACY_CAMERA_INTEGRATION = 'Terminal'

export class TerminalAddon extends BaseAddon<TerminalAddonConfig> {
  private manager: TerminalSessionManager | null = null
  private dataPlane: AddonDataPlaneHandle | null = null
  private cameraRelay: TerminalCameraRelay | null = null
  private cameraReconcileTimer: ReturnType<typeof setInterval> | null = null
  private readonly cameraProfilesByNode = new Map<
    string,
    Awaited<ReturnType<TerminalCameraRelay['listProfiles']>>
  >()
  /** The Terminal camera blocks hosted on their composer rows (hub only). */
  private cameraHost: TerminalCameraHost | null = null
  /** The cameras declared before Terminal cameras were blocks are gone (or there never were any). */
  private legacySwept = false
  private instances: RecordIntegrationInstances<TerminalBody> | null = null
  /** The configured instances, as the last read of the records saw them. */
  private instanceRows: readonly TerminalInstance[] = []
  /**
   * False until the records are readable and the instances migration landed: a camera is never
   * withdrawn on a list that may be incomplete.
   */
  private instancesTrusted = false
  /** The instances migration is applied; until it is, the records are not the list. */
  private migrationLanded = false
  /** Instance ids whose node was absent from the last topology read (D49 streak). */
  private instancesOnAbsentNodes: ReadonlySet<string> = new Set()
  private readonly absentNodeAlerts = new AbsentNodeAlerts({
    raise: async (alert) => {
      await this.ctx.api.alerts.emit.mutate(alert)
    },
    clear: async (alertId) => {
      await this.ctx.api.alerts.update.mutate({
        alertId,
        patch: { status: 'completed', updatedAt: Date.now() },
      })
    },
    log: (message, options) => this.ctx.logger.warn(message, options),
  })
  private readonly instanceMutationQueue = new TerminalInstanceMutationQueue()
  private readonly terminalReconcileCoordinator = new TerminalInstanceReconcileCoordinator(
    this.instanceMutationQueue,
  )
  private glancesPythonPath = ''
  private glancesEnv: Readonly<Record<string, string>> | undefined

  constructor() {
    super({ ...DEFAULTS })
  }

  protected async onInitialize(): Promise<AddonInitResult> {
    await warmNodePty()
    this.glancesPythonPath = (await this.ctx.deps.ensurePython()) ?? ''
    const shimDir = cursesShimDir()
    this.glancesEnv = resolveGlancesCursesShimEnv({
      platform: process.platform,
      shimDir,
      shimDirExists: cursesShimDirExists(shimDir),
      existingPythonPath: process.env['PYTHONPATH'],
    })
    this.probeGlancesCursesColours()

    const manager = new TerminalSessionManager({
      spawn: createNodePtySpawner(),
      screenFactory: createXtermScreen,
      resolveBinary: resolveExecutable,
      logger: this.ctx.logger,
      btmPath: this.config.btmPath,
      btmEnabled: this.config.btmEnabled,
      btmArgs: this.config.btmArgs,
      topEnabled: this.config.topEnabled,
      topPath: this.config.topPath,
      topArgs: this.config.topArgs,
      glancesEnabled: this.config.glancesEnabled,
      glancesPath: this.config.glancesPath,
      glancesArgs: this.config.glancesArgs,
      glancesPythonPath: this.glancesPythonPath,
      glancesEnv: this.glancesEnv,
      allowShell: this.config.allowShell,
      shellPath: this.config.shellPath,
      serverShell: this.serverShellSpawn(),
      serverShellEnabled: serverShellOptIn(this.config.serverShellEnabled),
      serverShellIdleMs: serverShellIdleMs(this.config.serverShellIdleMinutes),
      nodeId: declarationOwnerNodeId(this.ctx.kernel.localNodeId),
      maxSessions: this.config.maxSessions,
      customProfiles: this.config.customProfiles,
      cwd: this.ctx.nodeDataDir,
    })
    manager.startIdleWatch()
    this.manager = manager

    if (declarationOwnerNodeId(this.ctx.kernel.localNodeId) === 'hub') {
      const localNodeId = declarationOwnerNodeId(this.ctx.kernel.localNodeId)
      await this.initInstanceRecords()
      this.cameraHost = this.createCameraHost()
      const cameraRelay = new TerminalCameraRelay(
        {
          listProfiles: (nodeId) =>
            nodeId === localNodeId
              ? manager.listProfiles()
              : this.ctx.api.terminalSession.listProfiles.query(undefined, nodePin(nodeId)),
          openSession: async (nodeId, input) => {
            const instance = input.instanceId
              ? this.terminalInstances().find((row) => row.id === input.instanceId)
              : undefined
            const profiles =
              nodeId === localNodeId
                ? await manager.listProfiles()
                : await this.ctx.api.terminalSession.listProfiles.query(undefined, nodePin(nodeId))
            const profile = profiles.find(
              (candidate) => candidate.profileId === (instance?.profileId ?? input.profileId),
            )
            const args = instance
              ? spawnArgsForInstance({
                  profileId: instance.profileId,
                  instanceArgs: instance.args,
                  profileArgs: profile?.args ?? [],
                  profileSettings: instance.profileSettings,
                })
              : undefined
            const payload = {
              profileId: input.profileId,
              cols: input.cols,
              rows: input.rows,
              ...(instance
                ? {
                    ...(instance.executable ? { executable: instance.executable } : {}),
                    ...(args !== undefined ? { args: [...args] } : {}),
                    ...(instance.cwd ? { cwd: instance.cwd } : {}),
                    ...(instance.environment.length > 0
                      ? { environment: [...instance.environment] }
                      : {}),
                  }
                : {}),
            }
            return nodeId === localNodeId
              ? manager.openSession(payload)
              : this.ctx.api.terminalSession.openSession.mutate(payload, nodePin(nodeId))
          },
          pullOutput: (nodeId, input) =>
            nodeId === localNodeId
              ? manager.pullOutput(input)
              : this.ctx.api.terminalSession.pullOutput.mutate(input, nodePin(nodeId)),
          closeSession: async (nodeId, sessionId) => {
            if (nodeId === localNodeId) {
              await manager.close({ sessionId })
            } else {
              await this.ctx.api.terminalSession.close.mutate({ sessionId }, nodePin(nodeId))
            }
          },
        },
        this.ctx.logger.child('camera'),
        (instanceId) => this.cameraHost?.deviceIdFor(instanceId),
      )
      await cameraRelay.start()
      this.cameraRelay = cameraRelay
      installTerminalCameraRelay(cameraRelay)
      await this.reconcileTerminalCameras().catch((error: unknown) => {
        this.ctx.logger.warn('initial terminal camera reconciliation failed — will retry', {
          meta: { error: error instanceof Error ? error.message : String(error) },
        })
      })
      this.cameraReconcileTimer = setInterval(() => {
        void this.reconcileTerminalCameras().catch((error: unknown) => {
          this.ctx.logger.warn('terminal camera reconciliation failed', {
            meta: { error: error instanceof Error ? error.message : String(error) },
          })
        })
      }, CAMERA_RECONCILE_MS)
      this.cameraReconcileTimer.unref?.()
    }

    if (this.ctx.dataPlane) {
      this.dataPlane = await this.ctx.dataPlane.serve({
        prefix: DATA_PLANE_PREFIX,
        access: 'admin',
        handler: createTerminalDataPlaneHandler(manager),
      })
      this.ctx.logger.info(`terminal: I/O data plane served at ${this.dataPlane.prefix}`)
    } else {
      this.ctx.logger.warn('terminal: no data plane available — output/input transport is disabled')
    }

    return {
      providers: [
        { capability: terminalSessionCapability, provider: manager },
        ...(this.instances === null
          ? []
          : [
              {
                capability: integrationInstancesCapability,
                provider: this.instances.toProvider(),
              },
            ]),
      ],
    }
  }

  /**
   * Fire-and-forget canary: the managed python must see a colour-capable
   * curses, or glances paints its B&W theme (SGR conceal/reverse) and the
   * terminal camera frames lose their text. The shim filename is ABI-locked
   * (cpython-312), so a managed-python bump silently disables it — this probe
   * is what makes that failure loud instead of a garbled camera.
   */
  private probeGlancesCursesColours(): void {
    if (!this.glancesPythonPath) return
    const probeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.glancesEnv,
      TERM: 'xterm-256color',
    }
    execFile(
      this.glancesPythonPath,
      ['-c', "import curses\ncurses.setupterm('xterm-256color')\nprint(curses.tigetnum('colors'))"],
      { env: probeEnv, timeout: 10_000 },
      (error, stdout) => {
        const colours = error ? Number.NaN : Number.parseInt(stdout.trim(), 10)
        if (!Number.isFinite(colours) || colours <= 0) {
          this.ctx.logger.warn(
            'glances curses reports no colours — terminal camera frames will render the B&W theme',
            {
              meta: {
                colours: Number.isFinite(colours) ? colours : null,
                shimApplied: this.glancesEnv !== undefined,
                error: error ? (error instanceof Error ? error.message : String(error)) : undefined,
              },
            },
          )
          return
        }
        this.ctx.logger.debug('glances curses colours available', {
          meta: { colours, shimApplied: this.glancesEnv !== undefined },
        })
      },
    )
  }

  /** Login shell, data dir, and the allowlisted environment for this node. */
  private serverShellSpawn() {
    return resolveServerShell({
      platform: process.platform,
      inContainer: hostLooksLikeContainer(),
      shellFromEnv: process.env['SHELL'],
      dataDir: this.ctx.nodeDataDir,
      processEnv: process.env,
    })
  }

  protected async onConfigChanged(): Promise<void> {
    this.manager?.reconfigureProfiles({
      btmPath: this.config.btmPath,
      btmEnabled: this.config.btmEnabled,
      btmArgs: this.config.btmArgs,
      topEnabled: this.config.topEnabled,
      topPath: this.config.topPath,
      topArgs: this.config.topArgs,
      glancesEnabled: this.config.glancesEnabled,
      glancesPath: this.config.glancesPath,
      glancesArgs: this.config.glancesArgs,
      glancesPythonPath: this.glancesPythonPath,
      glancesEnv: this.glancesEnv,
      allowShell: this.config.allowShell,
      shellPath: this.config.shellPath,
      serverShell: this.serverShellSpawn(),
      serverShellEnabled: serverShellOptIn(this.config.serverShellEnabled),
      serverShellIdleMs: serverShellIdleMs(this.config.serverShellIdleMinutes),
      maxSessions: this.config.maxSessions,
      customProfiles: this.config.customProfiles,
    })
    // Hub-owned cameras mirror profiles from every node. Reconcile immediately
    // for local profile changes; remote nodes still converge on the bounded
    // periodic pass if their addon restarts independently.
    if (this.cameraRelay) {
      void this.reconcileTerminalCameras().catch((error: unknown) => {
        this.ctx.logger.warn('terminal camera reconciliation after config change failed', {
          meta: { error: error instanceof Error ? error.message : String(error) },
        })
      })
    }
  }

  protected async onShutdown(): Promise<void> {
    if (this.cameraReconcileTimer) clearInterval(this.cameraReconcileTimer)
    this.cameraReconcileTimer = null
    installTerminalCameraRelay(null)
    await this.cameraHost?.dispose()
    this.cameraHost = null
    await this.cameraRelay?.dispose()
    this.cameraRelay = null
    try {
      await this.dataPlane?.dispose()
    } catch {
      /* best-effort */
    }
    this.dataPlane = null
    this.manager?.stopIdleWatch()
    this.manager?.disposeAll()
    this.manager = null
  }

  private async reconcileTerminalCameras(): Promise<void> {
    return this.terminalReconcileCoordinator.request(() => this.applyTerminalCameraReconciliation())
  }

  private async applyTerminalCameraReconciliation(): Promise<void> {
    if (!this.cameraRelay) return
    await gatedTerminalCameraPass({
      logger: this.ctx.logger,
      refreshInstances: async () => {
        await this.refreshInstanceRows()
        return this.instancesTrusted
      },
      run: () => this.runTrustedCameraPass(),
    })
  }

  /** One camera pass over a trusted instance list (`gatedTerminalCameraPass`). */
  private async runTrustedCameraPass(): Promise<void> {
    if (!this.cameraRelay) return
    const topology = await this.ctx.api.nodes.topology.query()
    if (topology.length === 0) {
      throw new Error('cluster topology returned no nodes; refusing to withdraw declared cameras')
    }
    const nodes = topology.filter((node) => typeof node.id === 'string' && node.id.length > 0)
    const nodeIds = new Set(nodes.map((node) => node.id))
    for (const cachedNodeId of this.cameraProfilesByNode.keys()) {
      if (!nodeIds.has(cachedNodeId)) this.cameraProfilesByNode.delete(cachedNodeId)
    }
    // An instance bound to a node the cluster no longer lists is KEPT and
    // reported (see `instancesOnAbsentNodes`). Nothing here may call
    // `instanceMutationQueue.run`: this pass already holds it.
    const absent = instancesOnAbsentNodes(
      this.terminalInstances(),
      nodeIds,
      this.instancesOnAbsentNodes,
    )
    this.instancesOnAbsentNodes = absent.absentNow
    const confirmedAbsentIds = new Set(absent.confirmed.map((instance) => instance.id))
    const unavailableNodeIds = new Set<string>()
    await Promise.all(
      nodes.map(async (node) => {
        try {
          this.cameraProfilesByNode.set(node.id, await this.cameraRelay!.listProfiles(node.id))
        } catch (error) {
          unavailableNodeIds.add(node.id)
          this.ctx.logger.warn(
            'terminal profiles unavailable — keeping Terminal instance cameras offline',
            {
              meta: {
                nodeId: node.id,
                cachedProfiles: this.cameraProfilesByNode.has(node.id),
                error: error instanceof Error ? error.message : String(error),
              },
            },
          )
        }
      }),
    )
    await this.sweepLegacyCameras()
    const onlineByNode = new Map(
      nodes.map((node) => [node.id, node.isOnline && !unavailableNodeIds.has(node.id)]),
    )
    // A camera exists only for a block naming an operator-created Terminal,
    // never because a node advertises a profile.
    await this.cameraHost?.reconcile({
      terminals: this.terminalInstances(),
      isLive: (terminal) =>
        (onlineByNode.get(terminal.nodeId) ?? false) &&
        (this.cameraProfilesByNode
          .get(terminal.nodeId)
          ?.some((profile) => profile.profileId === terminal.profileId) ??
          false),
    })
    const absentEntries: AbsentNodeEntry[] = []
    for (const instance of this.terminalInstances()) {
      const deviceId = this.cameraHost?.deviceIdFor(instance.id)
      if (deviceId === undefined) continue
      absentEntries.push({
        instanceId: instance.id,
        instanceName: instance.name,
        nodeId: instance.nodeId,
        deviceId,
        absent: confirmedAbsentIds.has(instance.id),
      })
    }
    await this.absentNodeAlerts.sync(absentEntries).catch((error: unknown) => {
      this.ctx.logger.warn('could not sync the Terminal node-missing alerts', {
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
    })
  }

  /**
   * A Terminal camera is a rendered screen. Every analyzer on it finds nothing,
   * forever, at full cost — see `silence-analysis.ts` for the measurements, the
   * reason `motion-detection` is in the list, and why a failure THROWS instead
   * of warning.
   *
   * Written to the AUTHORITIES (`deviceManager.setWrapperActive`), not through
   * the deprecated switch cap the previous version used (D113). Written ONLY on
   * creation: an operator who deliberately turns detection back on for a
   * terminal must win, and a reconcile that re-asserted every pass would
   * silently overrule them once a minute.
   */
  private silenceAnalysisFor(deviceId: number): Promise<void> {
    return silenceAnalysisFor({ api: this.ctx.api, logger: this.ctx.logger }, deviceId)
  }

  private terminalInstances(): readonly TerminalInstance[] {
    return this.instanceRows
  }

  /** The host of the Terminal camera blocks: it reads the blocks and the composer's rows each pass. */
  private createCameraHost(): TerminalCameraHost {
    return new TerminalCameraHost({
      logger: this.ctx.logger.child('camera'),
      devices: this.ctx.kernel.devices,
      readBlocks: () => this.ctx.api.coreBlocks.listCompositions.query({}),
      readComposerRows: () =>
        this.ctx.api.deviceManager.listAll.query({
          addonId: COMPOSER_ADDON_ID,
          projection: 'slim',
        }),
      deleteBlock: async (blockId) => {
        await this.ctx.api.coreBlocks.delete.mutate({ blockId })
      },
      readDeviceFlags: async (deviceId) =>
        (await this.ctx.settings?.readDeviceStore(deviceId)) ?? {},
      writeDeviceFlags: async (deviceId, patch) => {
        await this.ctx.settings?.writeDeviceStore(deviceId, patch)
      },
      silence: (deviceId) => {
        // Without a store the flag cannot be kept: silencing is refused by name
        // rather than re-asserted over an operator who turned detection back on.
        if (!this.ctx.settings) {
          this.ctx.logger.warn('terminal: no settings store - analysis is not silenced', {
            tags: { deviceId },
          })
          return Promise.resolve()
        }
        return this.silenceAnalysisFor(deviceId)
      },
    })
  }

  /**
   * The Terminal cameras declared before they were blocks are not carried over
   * (planning#580: the operator recreates them as blocks). Every row this addon
   * still owns under its old integration is removed through the declared sweep
   * (`removeDevice` → tombstone, D865). No integration means nothing was ever
   * declared, and nothing is minted to find out.
   */
  private async sweepLegacyCameras(): Promise<void> {
    if (this.legacySwept) return
    try {
      const sweep = await sweepLegacyEngineRows(
        {
          logger: this.ctx.logger.child('legacy-sweep'),
          addonId: bareAddonId(this.ctx.id),
          devices: this.ctx.kernel.devices,
          localNodeId: this.ctx.kernel.localNodeId,
          getIntegration: (owner) =>
            this.ctx.api.integrations.getByAddonId.query({ addonId: owner }),
          // `{ addonId }` takes device-manager's INDEXED branch.
          listAddonRows: (owner) => this.ctx.api.deviceManager.listAll.query({ addonId: owner }),
        },
        LEGACY_CAMERA_INTEGRATION,
      )
      if (sweep.kind === 'swept' && sweep.removed.length > 0) {
        this.ctx.logger.info(
          'terminal: legacy Terminal cameras removed - recreate them as blocks',
          {
            meta: { removed: [...sweep.removed] },
          },
        )
      }
      if (legacySweepDone(sweep)) this.legacySwept = true
    } catch (error: unknown) {
      this.ctx.logger.warn('terminal: the legacy Terminal cameras could not be swept - retried', {
        meta: { error: errMsg(error) },
      })
    }
  }

  /**
   * Hub only: declare the `terminals` kind, serve it through `integration-instances`, move the old
   * settings list into records (D987), then read the rows. A migration that did not land leaves the
   * declared cameras exactly as they are (`instancesTrusted` stays false).
   */
  private async initInstanceRecords(): Promise<void> {
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('terminal: ctx.records is not available on the hub')
    }
    await records.declare({ terminals: terminalInstancesKind })
    this.instances = new RecordIntegrationInstances(records, terminalInstancesKind, {
      description: {
        role: 'services',
        instanceMode: 'multiple',
        kind: 'terminal',
        canTest: false,
        kinds: [
          {
            id: TERMINAL_INSTANCES_KIND_NAME,
            label: 'Terminal',
            functionCap: 'terminal-session',
            canTest: false,
          },
        ],
      },
      kindOf: () => TERMINAL_INSTANCES_KIND_NAME,
      formSchema: () => this.instanceForm(),
      initialBody: (name) => initialTerminalBody(name),
      mintId: () => crypto.randomUUID(),
      configured: (body) => isTerminalBodyConfigured(body),
      health: (_body, id) =>
        this.instancesOnAbsentNodes.has(id)
          ? {
              status: {
                state: 'error',
                label: 'Node missing',
                detail:
                  'The node this Terminal is bound to is not in the cluster. Re-point or delete it.',
              },
            }
          : {},
      validateWrite: ({ body }) => this.validateInstanceWrite(body),
      onChanged: (id, change) => this.onInstanceChanged(id, change),
    })
    const report = await this.runMigrations(ADDON_MIGRATIONS, terminalPortsOver)
    this.migrationLanded =
      report.declared &&
      !report.failed.includes(INSTANCES_TO_RECORDS_ID) &&
      !report.blocked.includes(INSTANCES_TO_RECORDS_ID)
    if (!this.migrationLanded) {
      this.ctx.logger.error(
        'terminal: the instances migration has not landed - the declared cameras are left as they are until it does',
        { meta: { declared: report.declared, failed: report.failed, blocked: report.blocked } },
      )
    }
    await this.refreshInstanceRows()
  }

  /** Re-read every configured instance record. A failed read changes nothing (D49). */
  private async refreshInstanceRows(): Promise<void> {
    const handle = this.ctx.records?.kind(terminalInstancesKind)
    if (handle === undefined || !this.migrationLanded) {
      this.instancesTrusted = false
      return
    }
    try {
      const raw: Record<string, unknown>[] = []
      let cursor: string | undefined
      do {
        const page = await handle.query({
          limit: 500,
          ...(cursor === undefined ? {} : { cursor }),
        })
        for (const row of page.records) {
          // A row still waiting for its form names no node and no profile: it declares no camera.
          if (isTerminalBodyConfigured(row.data)) raw.push(rawInstanceOfRecord(row.id, row.data))
        }
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)
      this.instanceRows = readTerminalInstances(raw, (message) => {
        this.ctx.logger.warn(message)
      })
      this.instancesTrusted = true
    } catch (error: unknown) {
      this.instancesTrusted = false
      this.ctx.logger.warn(
        'terminal: the instance records could not be read - keeping the last list',
        {
          meta: { error: error instanceof Error ? error.message : String(error) },
        },
      )
    }
  }

  /** The form of one Terminal: where it runs and what it runs. The profile's own settings are a row action. */
  private instanceForm(): ConfigUISchema {
    const labels = new Map<string, string>()
    for (const profiles of this.cameraProfilesByNode.values()) {
      for (const profile of profiles) {
        if (profile.profileId === SERVER_SHELL_PROFILE_ID) continue
        labels.set(profile.profileId, profile.label)
      }
    }
    return {
      sections: [
        {
          id: 'terminal',
          title: 'Terminal',
          description:
            'A Terminal runs one allowlisted profile on one node; a Terminal camera block shows it as a camera. Empty executable, arguments, directory and environment take the profile defaults.',
          columns: 2,
          fields: [
            {
              type: 'node-select',
              key: 'nodeId',
              label: 'Node',
              required: true,
              requiresCapability: 'terminal-session',
            },
            {
              type: 'select',
              key: 'profileId',
              label: 'Profile',
              required: true,
              options: [...labels].map(([value, label]) => ({ value, label })),
            },
            { type: 'text', key: 'executable', label: 'Executable' },
            { type: 'text', key: 'cwd', label: 'Working directory' },
            {
              type: 'tags',
              key: 'args',
              label: 'Arguments',
              description: 'One tag per argv entry.',
            },
            {
              type: 'tags',
              key: 'environment',
              label: 'Environment',
              description: 'NAME=value entries.',
            },
          ],
        },
      ],
    }
  }

  /** The save-time rule: a Terminal needs a node in the cluster and a profile that node offers. */
  private async validateInstanceWrite(
    raw: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const parsed = TerminalBodySchema.safeParse(raw)
    if (!parsed.success) throw new Error('The Terminal settings are not valid')
    const body = parsed.data
    if (body.nodeId.length === 0 || body.profileId.length === 0) {
      throw new Error('Pick a node and a profile for the Terminal')
    }
    if (body.profileId === SERVER_SHELL_PROFILE_ID) {
      throw new Error('Server shell is a session on the Terminal page, not a camera profile')
    }
    const relay = this.cameraRelay
    if (relay === null) throw new Error('Terminal instances are managed on the hub')
    const topology = await this.ctx.api.nodes.topology.query()
    if (!topology.some((node) => node.id === body.nodeId)) {
      throw new Error(`Terminal node '${body.nodeId}' is not in the cluster`)
    }
    const profiles = await relay.listProfiles(body.nodeId)
    const profile = profiles.find((candidate) => candidate.profileId === body.profileId)
    if (!profile) {
      throw new Error(`Terminal profile '${body.profileId}' is not available on ${body.nodeId}`)
    }
    // Empty spawn fields take the profile's own, as a new Terminal always did.
    return {
      profileLabel: profile.label,
      executable: body.executable.trim() || profile.executable || '',
      args: body.args.length > 0 ? body.args : [...(profile.args ?? [])],
      cwd: body.cwd.trim() || profile.cwd || '',
      environment:
        body.environment.length > 0 ? body.environment : [...(profile.environment ?? [])],
      profileSettings: sanitizeProfileSettings(body.profileId, body.profileSettings),
    }
  }

  /** Runs after every create / edit / switch / delete of a Terminal record, on the hub. */
  private async onInstanceChanged(id: string, change: InstanceChange): Promise<void> {
    const known = this.instanceRows.find((row) => row.id === id)
    if (change === 'deleted') {
      await this.absentNodeAlerts.release(id).catch((error: unknown) => {
        this.ctx.logger.warn('could not clear the Terminal node-missing alert', {
          meta: { instanceId: id, error: error instanceof Error ? error.message : String(error) },
        })
      })
      // The camera blocks go FIRST: closing the relay session talks to the
      // instance's node, which may be gone, and must never decide whether they do.
      await this.cameraHost?.deleteCamerasOf(id)
    }
    if (change !== 'created') {
      await this.cameraRelay?.closeInstance(id).catch((error: unknown) => {
        this.ctx.logger.warn('could not close the Terminal instance session', {
          meta: {
            instanceId: id,
            nodeId: known?.nodeId,
            error: error instanceof Error ? error.message : String(error),
          },
        })
      })
    }
    await this.reconcileTerminalCameras()
  }

  protected override scopedSettingsCapabilities(): readonly string[] {
    return ['terminal-session']
  }

  /** Every Terminal setting is per node: stored as `<key>@<nodeId>`, the panel shows the selected node's own. */
  protected override async nodeSettingsSchema(cap: string): Promise<ConfigUISchema | null> {
    if (cap !== 'terminal-session') return null
    return this.schema({
      sections: [
        {
          id: 'terminal',
          title: 'Terminal',
          description:
            'Interactive terminal sessions in the Admin UI. Only pre-declared profiles can be opened; a free-form command is never accepted. Every setting below is per node — the values you see belong to the node selected above.',
          columns: 2,
          fields: [
            this.field({
              type: 'number',
              key: 'maxSessions',
              label: 'Max concurrent sessions',
              min: 1,
              max: 32,
              step: 1,
              default: 4,
              perNode: true,
            }),
          ],
        },
        // One section per built-in profile. This is a VIEW grouping only —
        // the persisted keys are unchanged and still flat (`btmArgs`,
        // `glancesArgs`, ...), so nothing migrates. The operator asked "which
        // Terminal camera am I configuring", and a flat 12-field grid could
        // not answer it.
        {
          id: 'terminal-btm',
          title: 'BTM camera',
          description: 'bottom (btm) — CPU, memory, network and process monitor.',
          columns: 2,
          fields: [
            this.field({
              type: 'boolean',
              key: 'btmEnabled',
              label: 'Enabled',
              description: 'Offer the BTM profile on this node.',
              default: true,
              perNode: true,
            }),
            this.field({
              type: 'text',
              key: 'btmPath',
              label: 'Binary',
              description:
                'Path to the `btm` (bottom) executable. Leave empty to resolve from PATH.',
              placeholder: 'btm',
              default: '',
              perNode: true,
            }),
            this.field({
              type: 'tags',
              key: 'btmArgs',
              label: 'Arguments',
              description: 'Exact arguments passed to btm. One tag per argv entry.',
              default: [],
              perNode: true,
              span: 2,
            }),
          ],
        },
        {
          id: 'terminal-top',
          title: 'Top camera',
          description: 'The operating system process and resource monitor.',
          columns: 2,
          fields: [
            this.field({
              type: 'boolean',
              key: 'topEnabled',
              label: 'Enabled',
              description: 'Offer the Top profile on this node.',
              default: true,
              perNode: true,
            }),
            this.field({
              type: 'text',
              key: 'topPath',
              label: 'Binary',
              placeholder: 'top',
              default: '',
              perNode: true,
            }),
            this.field({
              type: 'tags',
              key: 'topArgs',
              label: 'Arguments',
              description: 'Exact arguments passed to top. One tag per argv entry.',
              default: [],
              perNode: true,
              span: 2,
            }),
          ],
        },
        {
          id: 'terminal-glances',
          title: 'Glances camera',
          description:
            'Cross-platform curses monitor, installed automatically into Dominevo embedded Python. Glances is the most expensive built-in profile — it only runs while somebody is watching, but while it runs it costs real CPU. See the Arguments help below before widening it.',
          columns: 2,
          fields: [
            this.field({
              type: 'boolean',
              key: 'glancesEnabled',
              label: 'Enabled',
              description: 'Offer the Glances profile on this node.',
              default: true,
              perNode: true,
            }),
            this.field({
              type: 'text',
              key: 'glancesPath',
              label: 'Binary override',
              description:
                'Optional executable override. Empty uses the automatically managed Python package.',
              placeholder: 'glances',
              default: '',
              perNode: true,
            }),
            this.field({
              type: 'tags',
              key: 'glancesArgs',
              label: 'Arguments',
              description: GLANCES_ARGS_DESCRIPTION,
              default: [...DEFAULT_GLANCES_ARGS],
              perNode: true,
              span: 2,
            }),
          ],
        },
        {
          id: 'terminal-server-shell',
          title: 'Server shell',
          description:
            'A login shell in this node’s data directory, for admins. Off until this node opts in. Sessions close after they sit idle.',
          columns: 2,
          fields: [
            this.field({
              type: 'boolean',
              key: 'serverShellEnabled',
              label: 'Allow server shell',
              description:
                'Lets an admin open a login shell on this node from the Terminal page. Off by default.',
              default: false,
              perNode: true,
            }),
            this.field({
              type: 'number',
              key: 'serverShellIdleMinutes',
              label: 'Idle timeout',
              description:
                'Close a server shell after this many minutes with no input and no output.',
              default: SERVER_SHELL_IDLE_DEFAULT_MINUTES,
              min: 1,
              max: 24 * 60,
              unit: 'minutes',
              perNode: true,
            }),
          ],
        },
        {
          id: 'terminal-shell',
          title: 'Interactive shell',
          description:
            'The one profile that is genuinely a command surface. Off by default; turning it on grants command execution as the server user to every admin.',
          columns: 2,
          fields: [
            this.field({
              type: 'boolean',
              key: 'allowShell',
              label: 'Allow interactive shell',
              description: 'Adds a "Shell" profile on this node.',
              default: false,
              perNode: true,
            }),
            this.field({
              type: 'text',
              key: 'shellPath',
              label: 'Shell binary',
              description:
                'Used only when the shell profile is enabled. Empty resolves to /bin/bash.',
              placeholder: '/bin/bash',
              default: '',
              perNode: true,
            }),
          ],
        },
        {
          id: 'terminal-profiles',
          title: 'Custom profiles',
          description:
            'Enabled profiles are available templates on this node. Create a Terminal instance on the Terminal page to declare a camera; session requests only carry the profile ID and commands cannot be overridden by clients.',
          columns: 1,
          fields: [
            this.field({
              type: 'editable-array',
              key: 'customProfiles',
              label: 'Profiles',
              perNode: true,
              default: [],
              maxRows: 32,
              addLabel: 'Add profile',
              emptyMessage: 'No custom profiles configured.',
              rowTitleTemplate: '{label} — {executable}',
              defaultItem: {
                enabled: true,
                profileId: '',
                label: '',
                description: '',
                executable: '',
                args: [],
                cwd: '',
                environment: [],
              },
              itemFields: [
                {
                  type: 'boolean',
                  key: 'enabled',
                  label: 'Enabled',
                  default: true,
                },
                {
                  type: 'text',
                  key: 'profileId',
                  label: 'Profile ID',
                  description: 'Stable lowercase slug, for example gpu-monitor.',
                  required: true,
                },
                { type: 'text', key: 'label', label: 'Display name', required: true },
                { type: 'textarea', key: 'description', label: 'Description', rows: 2 },
                {
                  type: 'text',
                  key: 'executable',
                  label: 'Executable',
                  description: 'Absolute path or a binary resolved from PATH.',
                  required: true,
                },
                {
                  type: 'tags',
                  key: 'args',
                  label: 'Arguments',
                  description: 'One exact process argument per tag.',
                  maxTags: 64,
                },
                {
                  type: 'text',
                  key: 'cwd',
                  label: 'Working directory',
                  description: 'Optional working directory for this profile.',
                },
                {
                  type: 'tags',
                  key: 'environment',
                  label: 'Environment',
                  description: 'Optional NAME=value entries merged into the process environment.',
                  maxTags: 64,
                },
              ],
            }),
          ],
        },
      ],
    })
  }
}
