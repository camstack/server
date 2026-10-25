/**
 * Terminal addon — hosts interactive pty sessions running an allowlisted
 * profile (`monitor` → `btm`), streamed to the Admin UI over the data plane.
 *
 * Phase 1 of docs/design/2026-07-26-terminal-session-design.md: a real TTY good
 * enough to run a full-screen program. Phase 2 (streaming a session as a camera)
 * is a separate device-provider concern and does not change this addon's cap.
 *
 * Its own package (not a builtin) because it carries a native dependency
 * (`node-pty`) and should update via `camstack deploy` independently of the
 * framework, exactly like the node-av decoder addon.
 */

import { execFile } from 'node:child_process'
import type {
  AddonDataPlaneHandle,
  ConfigUISchema,
  ProviderRegistration,
  TerminalInstanceInfo,
  TerminalLegacyCamera,
} from '@camstack/types'
import {
  BaseAddon,
  DeclaredDevices,
  DeviceType,
  declarationOwnerNodeId,
  nodePin,
  terminalSessionCapability,
} from '@camstack/types'
import { cursesShimDir, cursesShimDirExists, resolveGlancesCursesShimEnv } from './curses-shim.js'
import { sanitizeProfileSettings, spawnArgsForInstance } from './profile-settings.js'
import { createNodePtySpawner, resolveExecutable, warmNodePty } from './pty.js'
import { silenceAnalysisFor } from './silence-analysis.js'
import {
  buildTerminalInstanceCameraDeclarations,
  needsTerminalCameraConfigMigration,
  terminalCameraReconciliationIndex,
} from './terminal-camera-declarations.js'
import { installTerminalCameraRelay, TerminalCameraDevice } from './terminal-camera-device.js'
import { TerminalCameraRelay } from './terminal-camera-relay.js'
import { createTerminalDataPlaneHandler } from './terminal-data-plane.js'
import {
  listLegacyTerminalCameraCandidates,
  newTerminalCameraStableId,
  instancesOnForgottenNodes,
  readTerminalInstances,
  type TerminalInstance,
  TerminalInstanceMutationQueue,
  TerminalInstanceReconcileCoordinator,
} from './terminal-instances.js'
import { type TerminalInstanceControl, TerminalSessionManager } from './terminal-session-manager.js'
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
  readonly maxSessions: number
  readonly customProfiles: readonly Record<string, unknown>[]
  /** Hub-owned, operator-created camera declarations. */
  readonly terminalInstances: readonly Record<string, unknown>[]
  /** Durable deletion intent, including explicitly adopted legacy monitors. */
  readonly terminalCameraTombstones: readonly string[]
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
  maxSessions: 4,
  customProfiles: [],
  terminalInstances: [],
  terminalCameraTombstones: [],
}

const DATA_PLANE_PREFIX = 'io'
const CAMERA_RECONCILE_MS = 60_000
const TERMINAL_CAMERA_INTEGRATION = 'Terminal'

export class TerminalAddon extends BaseAddon<TerminalAddonConfig> {
  private manager: TerminalSessionManager | null = null
  private dataPlane: AddonDataPlaneHandle | null = null
  private cameraRelay: TerminalCameraRelay | null = null
  private cameraReconcileTimer: ReturnType<typeof setInterval> | null = null
  private readonly cameraProfilesByNode = new Map<
    string,
    Awaited<ReturnType<TerminalCameraRelay['listProfiles']>>
  >()
  /** Prevent repeat writes when a legacy device stays live after migration. */
  private readonly migratedTerminalCameraConfigIds = new Set<number>()
  private readonly terminalCameraTombstones = new Set<string>()
  /** Instance ids whose node was absent from the last topology read (D49 streak). */
  private instancesOnAbsentNodes: ReadonlySet<string> = new Set()
  private readonly instanceMutationQueue = new TerminalInstanceMutationQueue()
  private readonly terminalReconcileCoordinator = new TerminalInstanceReconcileCoordinator(
    this.instanceMutationQueue,
  )
  private glancesPythonPath = ''
  private glancesEnv: Readonly<Record<string, string>> | undefined

  constructor() {
    super({ ...DEFAULTS })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
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
      maxSessions: this.config.maxSessions,
      customProfiles: this.config.customProfiles,
    })
    this.manager = manager
    this.replaceTerminalCameraTombstones(this.config.terminalCameraTombstones)

    if (declarationOwnerNodeId(this.ctx.kernel.localNodeId) === 'hub') {
      const localNodeId = declarationOwnerNodeId(this.ctx.kernel.localNodeId)
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
      )
      await cameraRelay.start()
      this.cameraRelay = cameraRelay
      installTerminalCameraRelay(cameraRelay)
      manager.setInstanceControl(this.terminalInstanceControl())
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

    return [{ capability: terminalSessionCapability, provider: manager }]
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

  protected async onConfigChanged(): Promise<void> {
    this.replaceTerminalCameraTombstones(this.config.terminalCameraTombstones)
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
    await this.cameraRelay?.dispose()
    this.cameraRelay = null
    try {
      await this.dataPlane?.dispose()
    } catch {
      /* best-effort */
    }
    this.dataPlane = null
    this.manager?.disposeAll()
    this.manager = null
  }

  private async reconcileTerminalCameras(): Promise<void> {
    return this.terminalReconcileCoordinator.request(() => this.applyTerminalCameraReconciliation())
  }

  private async applyTerminalCameraReconciliation(): Promise<void> {
    if (!this.cameraRelay) return
    // DeclaredDevices indexes must be restricted to Terminal's fixed
    // integration. The addon id alone is not ownership: future Terminal-owned
    // non-camera devices must never be adopted into, or swept from, this
    // declaration set.
    let terminalIntegrationId: string | null | undefined
    const topology = await this.ctx.api.nodes.topology.query()
    if (topology.length === 0) {
      throw new Error('cluster topology returned no nodes; refusing to withdraw declared cameras')
    }
    const nodes = topology.filter((node) => typeof node.id === 'string' && node.id.length > 0)
    const nodeIds = new Set(nodes.map((node) => node.id))
    for (const cachedNodeId of this.cameraProfilesByNode.keys()) {
      if (!nodeIds.has(cachedNodeId)) this.cameraProfilesByNode.delete(cachedNodeId)
    }
    // An instance bound to a node the cluster has FORGOTTEN is removed, on
    // the second consecutive read that says so (see `instancesOnForgottenNodes`).
    const forgotten = instancesOnForgottenNodes(
      this.terminalInstances(),
      nodeIds,
      this.instancesOnAbsentNodes,
    )
    this.instancesOnAbsentNodes = forgotten.absentNow
    for (const instance of forgotten.remove) {
      this.ctx.logger.info('terminal instance removed — its node is no longer in the cluster', {
        meta: { instanceId: instance.id, nodeId: instance.nodeId, name: instance.name },
      })
      await this.instanceMutationQueue.run(() => this.deleteTerminalInstanceUnlocked(instance.id))
    }
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
    // Profiles are runnable templates only. A camera exists exclusively for a
    // durable operator-created instance, never because a node advertises a
    // profile.
    const cameraDeclarations = buildTerminalInstanceCameraDeclarations(this.terminalInstances())
    const declarationsByStableId = new Map(
      cameraDeclarations.map((camera) => [camera.stableId, camera] as const),
    )
    const declared = new DeclaredDevices({
      logger: this.ctx.logger.child('camera-declaration'),
      addonId: this.ctx.id,
      devices: this.ctx.kernel.devices,
      localNodeId: this.ctx.kernel.localNodeId,
      getIntegration: async (addonId) => {
        const integration = await this.ctx.api.integrations.getByAddonId.query({ addonId })
        terminalIntegrationId = integration?.id ?? null
        return integration
      },
      createIntegration: async (input) => {
        const integration = await this.ctx.api.integrations.create.mutate(input)
        terminalIntegrationId = integration.id
        return integration
      },
      updateIntegration: async ({ id, info }) => {
        await this.ctx.api.integrations.update.mutate({ id, info, skipRestart: true })
      },
      listOwnDevices: async () => {
        const rows = await this.ctx.api.deviceManager.listAll.query({ addonId: this.ctx.id })
        return terminalCameraReconciliationIndex(
          rows,
          terminalIntegrationId,
          cameraDeclarations,
          this.terminalCameraTombstones,
        )
      },
    })
    const result = await declared.reconcile({
      integrationName: TERMINAL_CAMERA_INTEGRATION,
      placement: 'hub',
      devices: cameraDeclarations.map((camera) => ({
        stableId: camera.stableId,
        name: camera.name,
        type: DeviceType.Camera,
        DeviceClass: TerminalCameraDevice,
        config: camera.config,
        role: 'terminal-camera',
      })),
    })
    const onlineByNode = new Map(
      nodes.map((node) => [node.id, node.isOnline && !unavailableNodeIds.has(node.id)]),
    )
    for (const outcome of result.devices) {
      if (outcome.device instanceof TerminalCameraDevice) {
        const declaration = declarationsByStableId.get(outcome.stableId)
        if (declaration) {
          const config = outcome.device.config
          const currentConfigMatches =
            config.get('instanceId') === declaration.config.instanceId &&
            config.get('nodeId') === declaration.config.nodeId &&
            config.get('profileId') === declaration.config.profileId &&
            config.get('profileLabel') === declaration.config.profileLabel
          if (
            !currentConfigMatches ||
            (!this.migratedTerminalCameraConfigIds.has(outcome.device.id) &&
              needsTerminalCameraConfigMigration(
                outcome.device.ctx.persistedConfig ?? {},
                declaration,
              ))
          ) {
            await config.setAll(declaration.config)
            this.migratedTerminalCameraConfigIds.add(outcome.device.id)
          }
        }
        if (outcome.created) await this.silenceAnalysisFor(outcome.device.id)
        const nodeId = outcome.device.config.get('nodeId')
        const profileId = outcome.device.config.get('profileId')
        const profileAvailable =
          this.cameraProfilesByNode
            .get(nodeId)
            ?.some((profile) => profile.profileId === profileId) ?? false
        outcome.device.setNodeOnline((onlineByNode.get(nodeId) ?? false) && profileAvailable)
      }
    }
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

  private terminalInstanceControl(): TerminalInstanceControl {
    return {
      listInstances: async () =>
        this.terminalInstances().map((instance) => this.instanceInfo(instance)),
      createInstance: async (input) => this.createTerminalInstance(input),
      updateInstance: async (input) => this.updateTerminalInstance(input),
      deleteInstance: async ({ instanceId }) => this.deleteTerminalInstance(instanceId),
      setInstanceEnabled: async ({ instanceId, enabled }) =>
        this.setTerminalInstanceEnabled(instanceId, enabled),
      listLegacyCameras: async () => this.listLegacyTerminalCameras(),
      adoptLegacyMonitor: async ({ stableId, name }) => this.adoptLegacyMonitor(stableId, name),
    }
  }

  private terminalInstances(): readonly TerminalInstance[] {
    return readTerminalInstances(this.config.terminalInstances, (message) => {
      this.ctx.logger.warn(message)
    })
  }

  private instanceInfo(instance: TerminalInstance): TerminalInstanceInfo {
    return {
      instanceId: instance.id,
      cameraStableId: instance.cameraStableId,
      nodeId: instance.nodeId,
      profileId: instance.profileId,
      profileLabel: instance.profileLabel,
      name: instance.name,
      enabled: instance.enabled,
      executable: instance.executable,
      args: instance.args,
      cwd: instance.cwd,
      environment: instance.environment,
      profileSettings: instance.profileSettings,
    }
  }

  private replaceTerminalCameraTombstones(stableIds: readonly string[]): void {
    this.terminalCameraTombstones.clear()
    for (const stableId of stableIds) {
      if (typeof stableId === 'string' && stableId.length > 0) {
        this.terminalCameraTombstones.add(stableId)
      }
    }
  }

  private async createTerminalInstance(input: {
    readonly targetNodeId: string
    readonly profileId: string
    readonly name?: string
    readonly executable?: string
    readonly args?: readonly string[]
    readonly cwd?: string
    readonly environment?: readonly string[]
    readonly profileSettings?: Readonly<Record<string, unknown>>
  }): Promise<TerminalInstanceInfo> {
    const instance = await this.instanceMutationQueue.run(() =>
      this.createTerminalInstanceUnlocked(input),
    )
    await this.reconcileTerminalCameras()
    return instance
  }

  private async createTerminalInstanceUnlocked(input: {
    readonly targetNodeId: string
    readonly profileId: string
    readonly name?: string
    readonly executable?: string
    readonly args?: readonly string[]
    readonly cwd?: string
    readonly environment?: readonly string[]
    readonly profileSettings?: Readonly<Record<string, unknown>>
  }): Promise<TerminalInstanceInfo> {
    const relay = this.cameraRelay
    if (!relay) throw new Error('Terminal instances are managed on the hub')
    const profiles = await relay.listProfiles(input.targetNodeId)
    const profile = profiles.find((candidate) => candidate.profileId === input.profileId)
    if (!profile) {
      throw new Error(
        `Terminal profile '${input.profileId}' is not available on ${input.targetNodeId}`,
      )
    }
    const topology = await this.ctx.api.nodes.topology.query()
    const node = topology.find((candidate) => candidate.id === input.targetNodeId)
    if (!node) throw new Error(`Terminal node '${input.targetNodeId}' no longer exists`)
    const id = crypto.randomUUID()
    const name =
      input.name?.trim() || `Terminal ${profile.label} - ${node.isHub ? 'Hub' : node.name}`
    const instance: TerminalInstance = {
      id,
      cameraStableId: newTerminalCameraStableId(id),
      nodeId: input.targetNodeId,
      profileId: profile.profileId,
      profileLabel: profile.label,
      name,
      enabled: true,
      executable: input.executable?.trim() || profile.executable || '',
      args: input.args ? [...input.args] : [...(profile.args ?? [])],
      cwd: input.cwd?.trim() || profile.cwd || '',
      environment: input.environment ? [...input.environment] : [...(profile.environment ?? [])],
      profileSettings: sanitizeProfileSettings(profile.profileId, input.profileSettings),
    }
    await this.updateGlobalSettings({
      terminalInstances: [...this.config.terminalInstances, instance],
    })
    return this.instanceInfo(instance)
  }

  private async updateTerminalInstance(input: {
    readonly instanceId: string
    readonly name?: string
    readonly executable?: string
    readonly args?: readonly string[]
    readonly cwd?: string
    readonly environment?: readonly string[]
    readonly profileSettings?: Readonly<Record<string, unknown>>
  }): Promise<TerminalInstanceInfo> {
    const updated = await this.instanceMutationQueue.run(() =>
      this.updateTerminalInstanceUnlocked(input),
    )
    await this.cameraRelay?.closeInstance(updated.instanceId)
    await this.reconcileTerminalCameras()
    return updated
  }

  private async updateTerminalInstanceUnlocked(input: {
    readonly instanceId: string
    readonly name?: string
    readonly executable?: string
    readonly args?: readonly string[]
    readonly cwd?: string
    readonly environment?: readonly string[]
    readonly profileSettings?: Readonly<Record<string, unknown>>
  }): Promise<TerminalInstanceInfo> {
    const instance = this.terminalInstances().find((candidate) => candidate.id === input.instanceId)
    if (!instance) throw new Error(`No such Terminal instance: ${input.instanceId}`)
    const updated: TerminalInstance = {
      ...instance,
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.executable !== undefined ? { executable: input.executable.trim() } : {}),
      ...(input.args !== undefined ? { args: [...input.args] } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd.trim() } : {}),
      ...(input.environment !== undefined ? { environment: [...input.environment] } : {}),
      ...(input.profileSettings !== undefined
        ? {
            profileSettings: sanitizeProfileSettings(instance.profileId, input.profileSettings),
          }
        : {}),
    }
    await this.updateGlobalSettings({
      terminalInstances: this.config.terminalInstances.map((candidate) =>
        candidate.id === input.instanceId ? updated : candidate,
      ),
    })
    return this.instanceInfo(updated)
  }

  private async deleteTerminalInstance(instanceId: string): Promise<void> {
    await this.instanceMutationQueue.run(() => this.deleteTerminalInstanceUnlocked(instanceId))
    await this.reconcileTerminalCameras()
  }

  private async deleteTerminalInstanceUnlocked(instanceId: string): Promise<void> {
    const instance = this.terminalInstances().find((candidate) => candidate.id === instanceId)
    if (!instance) return
    this.terminalCameraTombstones.add(instance.cameraStableId)
    await this.cameraRelay?.closeInstance(instance.id)
    await this.updateGlobalSettings({
      terminalInstances: this.config.terminalInstances.filter(
        (candidate) => candidate.id !== instanceId,
      ),
      terminalCameraTombstones: [
        ...new Set([...this.config.terminalCameraTombstones, instance.cameraStableId]),
      ],
    })
  }

  private async setTerminalInstanceEnabled(
    instanceId: string,
    enabled: boolean,
  ): Promise<TerminalInstanceInfo> {
    const instance = await this.instanceMutationQueue.run(() =>
      this.setTerminalInstanceEnabledUnlocked(instanceId, enabled),
    )
    await this.reconcileTerminalCameras()
    return instance
  }

  private async setTerminalInstanceEnabledUnlocked(
    instanceId: string,
    enabled: boolean,
  ): Promise<TerminalInstanceInfo> {
    const instance = this.terminalInstances().find((candidate) => candidate.id === instanceId)
    if (!instance) throw new Error(`No such Terminal instance: ${instanceId}`)
    if (!enabled) {
      this.terminalCameraTombstones.add(instance.cameraStableId)
      await this.cameraRelay?.closeInstance(instance.id)
    }
    const updated: TerminalInstance = { ...instance, enabled }
    const terminalInstances = this.config.terminalInstances.map((candidate) =>
      candidate.id === instanceId ? updated : candidate,
    )
    const terminalCameraTombstones = enabled
      ? this.config.terminalCameraTombstones.filter(
          (stableId) => stableId !== instance.cameraStableId,
        )
      : [...new Set([...this.config.terminalCameraTombstones, instance.cameraStableId])]
    await this.updateGlobalSettings({ terminalInstances, terminalCameraTombstones })
    return this.instanceInfo(updated)
  }

  private async listLegacyTerminalCameras(): Promise<readonly TerminalLegacyCamera[]> {
    const instances = this.terminalInstances()
    const instanceStableIds = new Set(instances.map((instance) => instance.cameraStableId))
    // `{ addonId }` takes device-manager's INDEXED `listByAddon` branch — this
    // addon's handful of rows, never the fleet. It must stay UNPROJECTED:
    // every field the legacy list renders lives in `config`, which the slim
    // projection returns as `{}` — see
    // `listLegacyTerminalCameraCandidates`' docblock.
    const rows = await this.ctx.api.deviceManager.listAll.query({ addonId: this.ctx.id })
    return listLegacyTerminalCameraCandidates(
      rows,
      instanceStableIds,
      this.terminalCameraTombstones,
      ({ deviceId, stableId }) => {
        this.ctx.logger.warn(
          'legacy Terminal camera skipped — its device config carries no nodeId, so it cannot be offered for adoption',
          { tags: { deviceId }, meta: { stableId } },
        )
      },
    )
  }

  private async adoptLegacyMonitor(
    stableId: string,
    requestedName?: string,
  ): Promise<TerminalInstanceInfo> {
    const instance = await this.instanceMutationQueue.run(() =>
      this.adoptLegacyMonitorUnlocked(stableId, requestedName),
    )
    await this.reconcileTerminalCameras()
    return instance
  }

  private async adoptLegacyMonitorUnlocked(
    stableId: string,
    requestedName?: string,
  ): Promise<TerminalInstanceInfo> {
    if (this.terminalCameraTombstones.has(stableId)) {
      throw new Error('This legacy Terminal camera was deleted and cannot be adopted')
    }
    const legacy = (await this.listLegacyTerminalCameras()).find(
      (camera) => camera.stableId === stableId,
    )
    if (!legacy?.adoptable) {
      throw new Error('Only a legacy monitor camera with its original stable id can be adopted')
    }
    const id = crypto.randomUUID()
    const instance: TerminalInstance = {
      id,
      cameraStableId: legacy.stableId,
      nodeId: legacy.nodeId,
      profileId: 'monitor',
      profileLabel: legacy.profileLabel,
      name: requestedName?.trim() || legacy.name,
      enabled: true,
      executable: '',
      args: [],
      cwd: '',
      environment: [],
      profileSettings: {},
    }
    await this.updateGlobalSettings({
      terminalInstances: [...this.config.terminalInstances, instance],
    })
    return this.instanceInfo(instance)
  }

  protected globalSettingsSchema(): ConfigUISchema {
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
            'Cross-platform curses monitor, installed automatically into CamStack embedded Python. Glances is the most expensive built-in profile — it only runs while somebody is watching, but while it runs it costs real CPU. See the Arguments help below before widening it.',
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
