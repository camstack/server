import { z } from 'zod'
import {
  DeviceType,
  DeviceFeature,
  DeviceConfig,
  buildDeviceAdminUrl,
  deviceAdminLinkCapability,
  snapshotCapability,
  ptzCapability,
  startReachabilityPoll,
} from '@camstack/types'
import type {
  ConfigUISchemaWithValues,
  IDevice,
  DeviceContext,
  INativeSnapshot,
  ICameraDevice,
  ReachabilityPollHandle,
  StreamSourceEntry,
  InferNativeProvider,
  InferProvider,
} from '@camstack/types'
import type { OnvifClient } from './onvif-client.js'
import { ONVIF_PTZ_TIMEOUT_MS } from './onvif-client.js'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const onvifCameraSchema = z.object({
  name: z.string().describe('Camera display name'),
  host: z.string().describe('Camera IP address or hostname'),
  port: z.number().default(80).describe('ONVIF port (default: 80)'),
  username: z.string().default('').describe('ONVIF username'),
  password: z.string().default('').describe('ONVIF password').meta({ secret: true }),
  rtspUrl: z.string().describe('Primary RTSP stream URL'),
  subStreamUrl: z.string().default('').describe('Sub-stream RTSP URL (optional)'),
  snapshotUrl: z.string().default('').describe('Native snapshot URL (optional)'),
  profileToken: z.string().default('').describe('Main ONVIF media profile token'),
  subProfileToken: z
    .string()
    .default('')
    .describe('Sub-stream ONVIF media profile token (optional)'),
  videoWidth: z.number().optional().describe('Main stream video width'),
  videoHeight: z.number().optional().describe('Main stream video height'),
  subVideoWidth: z.number().optional().describe('Sub-stream video width'),
  subVideoHeight: z.number().optional().describe('Sub-stream video height'),
  hasPtz: z.boolean().default(false).describe('Whether camera supports PTZ'),
  manufacturer: z.string().default('').describe('Camera manufacturer'),
  model: z.string().default('').describe('Camera model'),
  firmware: z.string().default('').describe('Camera firmware version'),
})

export type OnvifCameraConfig = z.infer<typeof onvifCameraSchema>

// ---------------------------------------------------------------------------
// Device class
// ---------------------------------------------------------------------------

/**
 * ONVIF camera device.
 *
 * Implements `IDevice` with the `NativeSnapshot` feature when a snapshot
 * URL is available.  PTZ methods are exposed as plain instance methods so the
 * addon / capability layer can delegate to them; they are NOT registered as a
 * `DeviceFeature` because the existing capability system handles PTZ via
 * the `PanTiltZoom` feature.
 */
export class OnvifCamera implements IDevice, INativeSnapshot, ICameraDevice {
  readonly id: number
  readonly stableId: string
  readonly type = DeviceType.Camera
  readonly name: string
  /** Operator-organisational location label. Settable via the
   *  device-manager cap; legacy ONVIF cameras default to null. */
  readonly location: string | null = null
  /** Soft-disabled flag — drivers consult this; the kernel doesn't
   *  enforce. Defaults to false (active). */
  readonly disabled: boolean = false
  readonly parentDeviceId: number | null
  readonly features: readonly DeviceFeature[]
  readonly config: DeviceConfig<typeof onvifCameraSchema>
  readonly ctx: DeviceContext
  online = true

  markOnline(online: boolean): void {
    this.online = online
  }

  /**
   * Invoke a device custom action. ONVIF cameras register no device
   * custom actions, so every action is unknown — mirrors `BaseDevice`'s
   * default of throwing for an unregistered action.
   */
  async runDeviceAction(action: string, _input: unknown): Promise<unknown> {
    throw new Error(`unknown device action "${action}" on device ${this.id}`)
  }

  /**
   * Live ONVIF client — injected after connection is established.
   * `null` when the camera is being restored from DB without a live connection.
   */
  private client: OnvifClient | null

  /** Control-plane reachability poll — drives `online` from ONVIF
   *  `getDeviceInformation` liveness, decoupled from stream-broker video
   *  health. Started on `attachClient`, stopped on `removeDevice`. */
  private reachabilityPoll: ReachabilityPollHandle | null = null

  constructor(
    ctx: DeviceContext,
    initialData: Record<string, unknown>,
    client: OnvifClient | null = null,
  ) {
    this.ctx = ctx
    this.id = ctx.id
    this.stableId = ctx.stableId
    this.parentDeviceId = ctx.parentDeviceId
    this.client = client

    this.config = DeviceConfig.fromSchema(
      onvifCameraSchema,
      ctx.persistConfig as (data: OnvifCameraConfig) => Promise<void>,
      initialData,
    )

    this.name = this.config.get('name') || String(initialData['name'] ?? 'ONVIF Camera')

    // Advertise NativeSnapshot only when a snapshot URL was discovered
    this.features = this.config.get('snapshotUrl')
      ? ([DeviceFeature.NativeSnapshot] as const)
      : ([] as const)

    this.registerNativeCapabilities()
  }

  // ── Native capability registration ───────────────────────────────────────

  /**
   * Publish per-device native capability providers via
   * `DeviceContext.registerNativeCap`. Called once from the constructor
   * after `config` and `features` are settled. The kernel cleans these
   * registrations up automatically on `device-manager.remove(deviceId)`
   * via `CapabilityRegistry.unregisterAllNativeForDevice`.
   *
   * Note: legacy `INativeSnapshot` / direct PTZ method exposure on the
   * class is intentionally retained — it will be removed in Task 8.1
   * after the legacy consumers are swept.
   */
  private registerNativeCapabilities(): void {
    if (this.config.get('snapshotUrl')) {
      const snapshotProvider: InferNativeProvider<typeof snapshotCapability> = {
        getSnapshot: async ({ deviceId }) => {
          if (deviceId !== this.id) {
            throw new Error(`OnvifCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
          }
          const buf = await this.getSnapshot()
          if (buf.length === 0) return null
          return { base64: buf.toString('base64'), contentType: 'image/jpeg' }
        },
        invalidateCache: async () => {
          // No-op for native providers — caching is the orchestrator's job.
        },
      }
      this.ctx.registerNativeCap(snapshotCapability, snapshotProvider)
    }

    // device-admin-link — a generic ONVIF camera's own web console.
    //
    // The honest limit of this provider: `port` is the ONVIF SERVICE port, and
    // on several vendors that is not the port the web UI listens on (a
    // Hikvision speaking ONVIF answers on 8000 while its page is on 80). When
    // the configured port IS an HTTP port we know the answer; when it is not,
    // this provider CANNOT say, and it says so by answering null rather than
    // guessing 80 and shipping a button that opens a browser error.
    {
      const provider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
        getAdminLink: async ({ deviceId }) => {
          if (deviceId !== this.id) {
            throw new Error(`OnvifCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
          }
          const host = this.config.get('host') ?? ''
          const port = this.config.get('port') ?? 80
          if (port !== 80 && port !== 443) {
            this.ctx.logger.debug(
              'onvif admin link unavailable: service port is not an HTTP port',
              {
                tags: { deviceId: this.id },
                meta: { port },
              },
            )
            return null
          }
          const built = buildDeviceAdminUrl({
            host,
            port,
            scheme: port === 443 ? 'https' : 'http',
            path: '/',
          })
          if (!built.ok) {
            this.ctx.logger.debug('onvif admin link unavailable', {
              tags: { deviceId: this.id },
              meta: { reason: built.reason },
            })
            return null
          }
          return { url: built.url, label: 'Web UI', target: 'device' as const, host }
        },
      }
      this.ctx.registerNativeCap(deviceAdminLinkCapability, provider)
    }

    if (this.hasPtz()) {
      const ptzProvider: InferProvider<typeof ptzCapability> = {
        move: async ({ deviceId, pan, tilt, zoom, speed }) => {
          if (deviceId !== this.id) {
            throw new Error(`OnvifCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
          }
          await this.ptzMove({ pan, tilt, zoom, speed })
        },
        continuousMove: async () => {
          throw new Error('OnvifCamera: continuousMove not implemented')
        },
        stop: async ({ deviceId }) => {
          if (deviceId !== this.id) {
            throw new Error(`OnvifCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
          }
          await this.ptzStop()
        },
        getPresets: async ({ deviceId }) => {
          if (deviceId !== this.id) {
            throw new Error(`OnvifCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
          }
          // `savePreset` / `deletePreset` throw "not implemented" on this
          // driver, so NO preset here is writable. That is a fact about our
          // ONVIF support, not a guess about the firmware.
          const presets = await this.getPtzPresets()
          return presets.map((preset) => ({ ...preset, fn: null, writable: false }))
        },
        goToPreset: async ({ deviceId, presetId }) => {
          if (deviceId !== this.id) {
            throw new Error(`OnvifCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
          }
          await this.goToPreset(presetId)
        },
        savePreset: async () => {
          // ONVIF `SetPreset` is not wired yet — the bare ONVIF driver
          // only exposes move / stop / goto. Surfaced as a thrown error
          // rather than a silent no-op so the operator gets feedback.
          throw new Error('OnvifCamera: savePreset not implemented')
        },
        deletePreset: async () => {
          throw new Error('OnvifCamera: deletePreset not implemented')
        },
        goHome: async ({ deviceId }) => {
          if (deviceId !== this.id) {
            throw new Error(`OnvifCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
          }
          await this.goHome()
        },
        getHomePreset: async ({ deviceId }) => {
          if (deviceId !== this.id) {
            throw new Error(`OnvifCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
          }
          // ONVIF homes WITHOUT a preset -- `goHome` is an absolute move to
          // the origin -- so there is nothing to configure and nothing to
          // refuse. `native` is what tells the UI to offer no picker.
          return { presetId: null, source: 'native' as const }
        },
        captureHomeHere: async () => {
          // ONVIF's home is the PTZ origin, a fixed point of the coordinate
          // system. There is nothing to move it to. Throwing beats a silent
          // no-op: an operator who pressed "set home here" and saw no error
          // would believe it took.
          throw new Error(
            'OnvifCamera: home is the PTZ origin on ONVIF and cannot be moved to the current position',
          )
        },
        getHomeReturn: async () => {
          // No idle-return behaviour on this driver. `null` is "no such timer",
          // which the UI renders as an absent control rather than as zero.
          return null
        },
        setHomeReturn: async () => {
          throw new Error('OnvifCamera: no idle-return timer on this driver')
        },
        setHomePreset: async () => {
          throw new Error(
            'OnvifCamera: home is the PTZ origin on ONVIF and cannot be pointed at a preset',
          )
        },
        getPosition: async () => {
          throw new Error('OnvifCamera: getPosition not implemented')
        },
        getOptions: async () => {
          // The bare ONVIF driver doesn't probe per-axis PTZ capability;
          // a camera that reports PTZ support gets all axes advertised.
          // Autofocus is not driven through this cap on ONVIF.
          return {
            hasPan: true,
            hasTilt: true,
            hasZoom: true,
            supportsPresets: true,
            hasAutofocus: false,
            // ONVIF takes a FLOAT velocity in -1..1, so there is no step count
            // to report. `null` says "continuous", not "unknown magnitude".
            speedSteps: null,
            moveImpulseMs: ONVIF_PTZ_TIMEOUT_MS,
          }
        },
        // Stub status: real ONVIF PTZ position tracking would need a
        // `GetStatus` call against the PTZ WSDL — not wired here. Returns
        // zeros (autofocus false) so the cap's `getStatus` contract is
        // satisfied. Real firmware integration comes later.
        // ONVIF `getPosition` throws outright; the status surface must not
        // quietly answer "centred" where the other one refuses (D393).
        getStatus: async () => ({ pan: null, tilt: null, zoom: null, autofocus: false }),
        setAutofocus: async () => {
          // No-op — ONVIF autofocus isn't driven through this cap
          // (`getOptions().hasAutofocus` is false).
        },
      }
      this.ctx.registerNativeCap(ptzCapability, ptzProvider)
    }
  }

  // ── INativeSnapshot ──────────────────────────────────────────────────────

  async getSnapshot(): Promise<Buffer> {
    const url = this.config.get('snapshotUrl')
    if (!url) return Buffer.alloc(0)
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`ONVIF snapshot fetch failed: ${res.status} ${res.statusText}`)
    }
    return Buffer.from(await res.arrayBuffer())
  }

  // ── PTZ helpers (delegated from capability layer) ────────────────────────

  hasPtz(): boolean {
    return this.config.get('hasPtz')
  }

  async ptzMove(cmd: {
    pan?: number
    tilt?: number
    zoom?: number
    speed?: number
  }): Promise<void> {
    if (!this.client) throw new Error(`OnvifCamera ${this.stableId}: no live client for PTZ`)
    await this.client.ptzMove({ x: cmd.pan, y: cmd.tilt, zoom: cmd.zoom, speed: cmd.speed })
  }

  async ptzStop(): Promise<void> {
    if (!this.client) throw new Error(`OnvifCamera ${this.stableId}: no live client for PTZ`)
    await this.client.ptzStop()
  }

  async getPtzPresets(): Promise<Array<{ id: string; name: string }>> {
    if (!this.client) throw new Error(`OnvifCamera ${this.stableId}: no live client for PTZ`)
    const presets = await this.client.getPtzPresets()
    return presets.map((p) => ({ id: p.token, name: p.name }))
  }

  async goToPreset(presetId: string): Promise<void> {
    if (!this.client) throw new Error(`OnvifCamera ${this.stableId}: no live client for PTZ`)
    await this.client.gotoPreset(presetId)
  }

  async goHome(): Promise<void> {
    if (!this.client) throw new Error(`OnvifCamera ${this.stableId}: no live client for PTZ`)
    await this.client.ptzAbsoluteMove({ x: 0, y: 0, zoom: 0 })
  }

  // ── Stream helpers ───────────────────────────────────────────────────────

  getRtspUrl(): string {
    return this.config.get('rtspUrl')
  }

  getSubStreamUrl(): string {
    return this.config.get('subStreamUrl')
  }

  // ── ICameraDevice ────────────────────────────────────────────────────────

  async getStreamSources(): Promise<readonly StreamSourceEntry[]> {
    const sources: StreamSourceEntry[] = []

    const rtspUrl = this.config.get('rtspUrl')
    if (rtspUrl) {
      const videoWidth = this.config.get('videoWidth')
      const videoHeight = this.config.get('videoHeight')
      const mainSource: StreamSourceEntry = {
        id: 'main',
        label: 'Main Stream',
        protocol: 'rtsp',
        url: rtspUrl,
        profileHint: 'high',
        ...(videoWidth !== undefined && videoHeight !== undefined
          ? { resolution: { width: videoWidth, height: videoHeight } }
          : {}),
      }
      sources.push(mainSource)
    }

    const subStreamUrl = this.config.get('subStreamUrl')
    if (subStreamUrl) {
      const subVideoWidth = this.config.get('subVideoWidth')
      const subVideoHeight = this.config.get('subVideoHeight')
      const subSource: StreamSourceEntry = {
        id: 'sub',
        label: 'Sub Stream',
        protocol: 'rtsp',
        url: subStreamUrl,
        profileHint: 'low',
        ...(subVideoWidth !== undefined && subVideoHeight !== undefined
          ? { resolution: { width: subVideoWidth, height: subVideoHeight } }
          : {}),
      }
      sources.push(subSource)
    }

    return sources
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Attach a live ONVIF client after the device has been created from DB.
   * Called by the addon when it successfully connects to the camera on boot.
   */
  attachClient(client: OnvifClient): void {
    this.client = client
    this.online = true
    this.startReachabilityPolling()
  }

  /** Start the control-plane reachability poll: an ONVIF
   *  `getDeviceInformation` round-trip every 30s drives `online`, with
   *  hysteresis. Replaces the old stream-health→online coupling so a
   *  reachable on-demand camera still reports ONLINE. Re-armed on each
   *  `attachClient` (reconnect) — the prior poll is stopped first. */
  private startReachabilityPolling(): void {
    this.reachabilityPoll?.stop()
    this.reachabilityPoll = startReachabilityPoll({
      probe: async () => {
        const client = this.client
        if (!client) return false
        await client.getDeviceInfo()
        return true
      },
      setOnline: (online) => {
        this.markOnline(online)
      },
      isEnabled: () => !this.disabled && this.client !== null,
      logger: this.ctx.logger,
    })
  }

  async removeDevice(): Promise<void> {
    this.reachabilityPoll?.stop()
    this.reachabilityPoll = null
    this.client?.disconnect()
    this.client = null
    this.online = false
    this.ctx.logger.info('Removed ONVIF camera', { meta: { stableId: this.stableId } })
  }

  // --- Device settings UI (IDevice contract) ---

  getSettingsUISchema(): ConfigUISchemaWithValues {
    return { sections: [] }
  }

  async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    await this.config.setAll(patch)
  }
}
