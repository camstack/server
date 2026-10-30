import type { ProviderRegistration } from '@camstack/types'
import { createClientLogIngest, entryDeviceId } from './client-log-ingest'
import { type BrokerFfmpegWiring, wireBrokerFfmpeg } from './stream-broker/ffmpeg-reresolve.js'
import {
  BaseAddon,
  EventCategory,
  createEvent,
  streamBrokerCapability,
  cameraStreamsCapability,
  webrtcSessionCapability,
  errMsg,
  memoizePinnedFfmpeg,
  addonWidgetsSourceCapability,
  createLogChannelsProvider,
  loadContributionCapability,
  logChannelsCapability,
  type IAddonWidgetsSourceProvider,
  type IScopedLogger,
  type DurableState,
  type IDeviceRemovalHookProvider,
  armRemovalReconcile,
  deviceRemovalHookCapability,
  type LogChannelsProviderHandle,
} from '@camstack/types'
// The declarations RUN on first evaluation of that module; importing the list
// by VALUE is what pins it to one instance. A bare side-effect import let the
// bundler emit it twice — see the note on `STREAM_BROKER_LOG_CHANNELS`.
import { STREAM_BROKER_LOG_CHANNELS } from './log-channels.js'
import { type ProbedSnapshotMap } from './stream-broker/probed-summary.js'
import {
  flattenByDevice,
  groupByDevice,
  mergeRtspTokens,
  probeSnapshotsMirror,
  profileMapMirror,
  rtspTokensMirror,
  type BrokerDeviceSettings,
  type DeviceKeyMirror,
  type ProbeSnapshotsOfDevice,
  type ProfileAssignment,
  type RtspTokensOfDevice,
} from './broker-device-state.js'
import { hwAccelOptionLabel } from './stream-broker/stream-broker-manager'
import {
  StreamBrokerManager,
  type ProfileMapPersister,
  type DeviceOverride,
  DeviceOverridesMapSchema,
  type DeviceOverridesMap,
  RtspEnabledSchema,
  type RtspEnabledBlob,
} from './stream-broker/stream-broker-manager'
import { JOIN_BURST_MAX_SPAN_LIMIT_MS, JOIN_BURST_MIN_SPAN_MS } from './rtsp/join-burst-bound.js'
import { DEFAULT_PREBUFFER_SEC, PREBUFFER_MAX_SEC, PREBUFFER_MIN_SEC } from './prebuffer.js'
import { DEFAULT_PRIME_BURST_BOUND } from './rtsp/rtsp-restreamer.js'
import { CameraStreamsProvider, WebrtcSessionProvider } from './device-scoped-providers'
import { BrokerWebrtcServer } from './webrtc/broker-webrtc-server'
import { dialAnswerFromError } from './recorded/clip-stream-dial-answer.js'
import { startBrokerMemReport } from './broker-mem-report.js'
import { EventLoopStallMonitor } from './event-loop-stall-monitor'
import {
  retractRemovedDevice,
  subscribeDeviceRemoval,
  type DeviceRemovalDeps,
} from './device-removal.js'
import { createBrokerRemovalHook } from './device-removal-hook.js'
import { TokenRecovery } from './rtsp-token-recovery.js'
import type { FfmpegHwAccelSetting } from './stream-broker/ffmpeg-invocation'
import { FFMPEG_HW_ACCEL_SETTINGS } from './stream-broker/ffmpeg-invocation'
import type { CamProfile } from '@camstack/types'
import { ChildCostRegistry } from '@camstack/types/node'

/** Seams `hydratePersistedRtspState` needs (durable handles + broker sinks). */
export interface PersistedRtspStateDeps {
  /** Per-camera tokens (a keychain-held per-device setting), loaded once; throws when unreadable. */
  readonly tokensMirror: Pick<DeviceKeyMirror<RtspTokensOfDevice>, 'load'>
  /** Still a blob key: see the note on `rtspEnabled` in `broker-device-state.ts`'s history (D184). */
  readonly enabledState: DurableState<RtspEnabledBlob>
  readonly loadTokens: (tokens: ReadonlyMap<string, string>) => void
  readonly loadEnabled: (states: ReadonlyMap<string, boolean>) => void
  readonly logger: Pick<IScopedLogger, 'info'>
}

/**
 * Hydrate the persisted RTSP restream state. Tokens come from the cameras' own
 * settings; `rtspEnabled` is still a key of the settings row. An unreadable
 * token set THROWS (the caller refuses to write tokens afterwards - a
 * replacement minted over a token that was merely unreadable would turn every
 * external NVR URL into a 404), and an empty set keeps first-boot silence.
 */
export async function hydratePersistedRtspState(deps: PersistedRtspStateDeps): Promise<void> {
  const rows = await deps.tokensMirror.load()
  const tokens = flattenByDevice(rows)
  if (tokens.size > 0) {
    deps.loadTokens(tokens)
    deps.logger.info('Loaded persisted RTSP tokens', {
      meta: { tokenCount: tokens.size },
    })
  }
  const states = new Map(Object.entries(await deps.enabledState.get()))
  if (states.size > 0) {
    deps.loadEnabled(states)
    deps.logger.info('Loaded persisted RTSP enabled states', {
      meta: { stateCount: states.size },
    })
  }
}

interface StreamBrokerConfig {
  /**
   * Cluster-wide default PREBUFFER, in seconds — the ONE history duration in
   * this subsystem (D381). It sizes every ring a broker retains and is the
   * ceiling on what any consumer can be served; nothing outside the broker
   * configures a window of its own. Per-camera-stream overrides live in
   * `DeviceOverride.preBuffer`.
   */
  readonly defaultPreBufferSec: number
  readonly rtspPort: number
  /**
   * How often (seconds) the broker re-pulls every camera's `stream-catalog`
   * to reconcile its cam-stream registry. The backstop for any missed
   * device / stream-params event; primary signal is those events, so a
   * generous cadence keeps the cost negligible.
   */
  readonly catalogReconcileIntervalSec: number
  /**
   * Cluster-wide default join-burst span bound (ms) for RTSP restream joins
   * (D57). Cluster-scoped, NOT `perNode`: the ingest node is a movable role,
   * so a per-node value would make a camera's join behaviour depend on which
   * node owned its ingest. Per-camera-stream overrides live in
   * `DeviceOverride.joinBurstMaxSpanMs`.
   */
  readonly joinBurstMaxSpanMs: number
  /** Per-node ffmpeg binary override (`binaryPath@<node>`); empty → ensureFfmpeg. */
  readonly binaryPath: string
  /** Per-node transcode decode/encode hwaccel preference (`hwaccel@<node>`).
   *  `copy` (default) = software; the concrete backend is resolved from the
   *  node-local `ctx.kernel.hwaccel`. Replaces the retired global `ffmpeg.hwAccel`. */
  readonly hwaccel: FfmpegHwAccelSetting
}

interface PersistedAssignment {
  readonly map: Partial<Record<CamProfile, string>>
  readonly auto: boolean
}

const PROFILE_KEYS: readonly CamProfile[] = ['high', 'mid', 'low']

/**
 * Cadence for the per-broker metrics-snapshot bus event. ~1 Hz keeps
 * UI dashboards (StreamBrokerPanel, broker stats overlays) live without
 * needing to poll `getBrokerStats` every 3s — admin-ui subscribes to
 * the snapshot category and updates state from the event payload.
 */
const BROKER_METRICS_SNAPSHOT_INTERVAL_MS = 1_000

/**
 * Build a dedup-key for a snapshot by serialising the payload with
 * monotonic counter fields stripped. Without this, fields like
 * `uptimeMs` / `totalBytes` / `packetCount` on broker stats — which
 * tick up every second regardless of state — make every JSON-equal
 * check fail and the defer never fires. Stripping happens in the
 * key only; the full payload still rides the bus when an emit
 * fires.
 */
function stableSnapshotKey<T>(payload: T, dropKeys: readonly string[]): string {
  const dropSet = new Set(dropKeys)
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (dropSet.has(k)) continue
        out[k] = strip(val)
      }
      return out
    }
    return v
  }
  return JSON.stringify(strip(payload))
}
/**
 * Force a broker-stats emit at least every 30s even when the
 * payload hasn't changed — gives consumers a heartbeat without
 * the per-tick spam an unconditional emit produces. Picks up
 * idle brokers (no encoded subscribers, status frozen at
 * `streaming` with stale fps/bitrate).
 */
const BROKER_METRICS_HEARTBEAT_MS = 30_000
/** Throttle for persisting the per-stream probe map — bounds writes regardless
 *  of streaming churn while keeping the durable copy recent enough for restart. */
const PROBE_SNAPSHOTS_PERSIST_INTERVAL_MS = 60_000

/**
 * Defensive timeout for the per-session `networkQuality.getDeviceStats` poll.
 * The stat is an OPTIONAL input to the adaptive downgrade ladder — never worth
 * blocking the loop for. When the hub-resident provider is transiently
 * undiscoverable the child's unowned-cap routing falls to the Moleculer
 * broker-fallback, whose discovery wait is ~30s; without this bound a single
 * poll would stall the adaptive loop for that long. On timeout we simply treat
 * the sample as absent (the RTCP Receiver-Report path drives the ladder anyway). */
const NETWORK_QUALITY_STATS_TIMEOUT_MS = 2_000

export class StreamBrokerAddon extends BaseAddon<StreamBrokerConfig> {
  /** The restream tokens of a camera are a per-device setting held in the keychain (D870). */
  protected override readonly secretStatePaths = ['rtspTokens']

  private brokerManager: StreamBrokerManager | null = null
  /** The node's pinned ffmpeg, mirrored here so the recorded-playback demuxers
   *  (segment-demux/segment-audio) spawn the same binary as the transcode
   *  egress. Kept in sync by the ffmpeg wiring. `null` = none could be resolved:
   *  their ffmpeg fallbacks refuse by name — never a PATH `ffmpeg` (D540). */
  private ffmpegBinaryPath: string | null = null
  /** The node's pinned build, asked once on success (D540). A failure is not
   *  remembered, so the re-resolve below can succeed later. */
  private readonly pinnedFfmpeg = memoizePinnedFfmpeg(() => this.ctx.deps.ensureFfmpeg())
  /**
   * The way back from a failed boot-time resolution: a refused child asks, and
   * ONE bounded re-resolve hands the binary to the manager config (which every
   * live broker reads per dial) and the demuxers. Without it one failed
   * download disabled every broker ffmpeg child until the runner restarted.
   */
  private ffmpegWiring: BrokerFfmpegWiring | null = null
  /** Once-per-addon log guard for the readGopBytes → whole-segment downgrade. */
  private gopReadFallbackLogged = false
  private metricsSnapshotTimer: ReturnType<typeof setInterval> | null = null
  private catalogReconcileTimer: ReturnType<typeof setInterval> | null = null
  /** Kept so onShutdown can close every live PeerConnection — releasing
   *  the ICE UDP sockets. Without this, a graceful runner respawn (deploy)
   *  leaks those sockets and wedges the next runner's werift ICE agent
   *  (DTLS never connects until a full hub restart). */
  private webrtcServer: BrokerWebrtcServer | null = null
  /** Stops the five-minute `[broker-mem]` attribution heartbeat. */
  private stopBrokerMemReport: (() => void) | null = null
  /** Names this process's event-loop stalls — see onInitialize. */
  private loopStallMonitor: EventLoopStallMonitor | null = null
  /** The `log-channels` provider for this process. Stopped on shutdown so a
   *  diagnostic timer never keeps a runner from exiting. */
  private logChannels: LogChannelsProviderHandle | null = null
  /**
   * The ffmpeg children this addon started, claimed at their spawn sites and
   * released at their exits. One registry per PROCESS: it dies with the
   * process, which is correct — those children were this process's children.
   */
  private readonly costRegistry = new ChildCostRegistry()
  /**
   * Snapshot-equality cache for the broker-metrics emit. Each
   * broker emits a stats snapshot every BROKER_METRICS_SNAPSHOT_-
   * INTERVAL_MS; for an idle broker (status=streaming, fps=0,
   * subscribers=0, bitrate frozen) the per-tick payload is
   * bytewise-identical and floods the bus to no end. We skip the
   * emit when the JSON-serialised payload matches the last one
   * and reset the heartbeat clock so a quiet broker still emits
   * every BROKER_METRICS_HEARTBEAT_MS.
   *
   * Keyed by broker.deviceId (the brokerId — `<deviceId>/<profile>`
   * string). Cleared when the broker manager is destroyed.
   */
  private readonly lastEmittedBrokerSnapshot = new Map<
    string,
    { json: string; emittedAt: number }
  >()
  /** Durable per-stream probe map (powers the settings "Probed" field across
   *  restarts). Loaded on activate, flushed throttled from the metrics loop and
   *  once on shutdown. */
  private probeSnapshots: DeviceKeyMirror<ProbeSnapshotsOfDevice> | null = null
  private removalHook: IDeviceRemovalHookProvider | null = null
  private lastProbePersistAt = 0

  constructor() {
    super({
      defaultPreBufferSec: DEFAULT_PREBUFFER_SEC,
      rtspPort: 8554,
      catalogReconcileIntervalSec: 30,
      joinBurstMaxSpanMs: DEFAULT_PRIME_BURST_BOUND.maxSpanMs,
      binaryPath: '',
      hwaccel: 'copy',
    })
  }

  /**
   * Resolve the ffmpeg binary for THIS node: a per-node `binaryPath` override
   * (`binaryPath@<node>`, the operator's voluntary choice) → else
   * `ensureFfmpeg()`, which provisions a binary WE provide (the image's, or the
   * static build it downloads). Replaces the retired global `ffmpeg` system
   * section (node-local/empty on agents → a cross-node footgun). There is no
   * PATH fallback: the host's ffmpeg is never ours.
   */
  private async resolveFfmpegBinaryPath(): Promise<string> {
    const override = this.config.binaryPath
    if (typeof override === 'string' && override.trim().length > 0) return override
    // Never PATH: the host's ffmpeg is not ours (see
    // packages/types/src/deps/ffmpeg-binary-source.ts). The ffmpeg wiring
    // already reports a failure here and leaves the broker without a config
    // rather than pointing it at a binary nobody chose.
    return await this.pinnedFfmpeg()
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    // Declare this addon's log channels to the cluster. The import of
    // `./log-channels.js` is what RUNS the declarations; registering the
    // provider is what lets the hub enumerate them and push an armed window
    // back into this process's gates. Without the second half a declared
    // channel is a knob with nothing behind it (D62).
    // Reading the list is what makes the import load-bearing, and it is the
    // operator-visible proof the declarations ran in THIS process.
    this.ctx.logger.info('log channels declared', {
      meta: { channels: STREAM_BROKER_LOG_CHANNELS.map((c) => c.descriptor.name) },
    })
    this.logChannels = createLogChannelsProvider(this.ctx.logger.child('log-channels'))
    const logChannelsRegistration: ProviderRegistration = {
      capability: logChannelsCapability,
      provider: this.logChannels,
    }

    // This addon's own cost, already attributed per camera. Computed live from
    // `costRegistry` when asked — no timer, no history, no persistence.
    const loadContributionRegistration: ProviderRegistration = {
      capability: loadContributionCapability,
      provider: { list: () => this.costRegistry.contributions() },
    }

    // Name this process's event-loop stalls. Production shows multi-second
    // freezes (all-camera source-RTP watchdog bursts in the same second; a
    // 6.8 s offer→answer gap between two log lines with no await between
    // them) that land 1:1 in remote time-to-first-frame and previously
    // surfaced only as their downstream symptoms. One WARN per stall, with
    // the measured duration — correlate by timestamp with the WebRTC
    // connect-phase brackets.
    this.loopStallMonitor = new EventLoopStallMonitor({
      onStall: (stallMs) => {
        this.ctx?.logger?.warn?.('event-loop stall — every session in this process froze', {
          meta: { stallMs },
        })
      },
    })
    this.loopStallMonitor.start()
    this.brokerManager = new StreamBrokerManager(this.ctx.logger)
    // Every ffmpeg this addon spawns — the per-camera source ingest and the
    // per-(camera, encode plan) transcode child — claims itself here at its
    // spawn site and releases at its exit. `load-contribution` reads it.
    this.brokerManager.setCostRegistry(this.costRegistry)
    this.brokerManager.setDefaultPreBufferSec(this.config.defaultPreBufferSec)
    this.brokerManager.setDefaultJoinBurstMaxSpanMs(this.config.joinBurstMaxSpanMs)
    this.brokerManager.setEventBus(this.ctx.eventBus)
    // Wire the tRPC api proxy so the broker can reach other caps (the stream
    // catalog, the decoder's per-node hwaccel probe, …) via
    // `localProviderLink` / `brokerTransportLink` regardless of where their
    // providers physically run. Bare node id only (strip any `node/addon`
    // form); undefined when unknown.
    const localNode = this.ctx.kernel.localNodeId
    const localNodeId = localNode
      ? localNode.includes('/')
        ? localNode.split('/')[0]
        : localNode
      : undefined
    // The bare node id pins the egress transcode's `decoder.getInfo` read to
    // THIS node's probe (an unpinned singleton call could answer for another).
    this.brokerManager.setApiAccess(this.ctx.api, localNodeId, this.ctx.kernel.hwaccel)
    // A DEVICE-scoped cap is read through the device proxy, not through a
    // system route: `listSignals` takes no deviceId because the proxy already
    // is the device. Injected rather than reached for, so the manager keeps
    // one way in and the addon keeps the kernel handles.
    const readSignals = async (deviceId: number) => {
      const proxy = await this.ctx.fetchDevice(deviceId)
      return (await proxy.streamSignals?.listSignals({})) ?? []
    }
    this.brokerManager.setDeviceSignalReader(async (deviceId) =>
      (await readSignals(deviceId)).map((s) => s.code),
    )
    this.brokerManager.setDeviceSignalDetailReader(readSignals)
    // Load this node's ffmpeg config (the pinned binary + the operator's
    // hw-accel preference). A miss leaves NO binary, and the first refused
    // child asks again through the re-resolver — never PATH (D540).
    // Built here, not as a field: the logger is the context's, set at init.
    this.ffmpegWiring = wireBrokerFfmpeg({
      host: this.brokerManager,
      resolve: () => this.resolveFfmpegBinaryPath(),
      hwAccel: () => this.config.hwaccel,
      onBinaryPath: (binaryPath) => {
        this.ffmpegBinaryPath = binaryPath
      },
      logger: this.ctx.logger,
    })
    await this.ffmpegWiring.load()

    // The three per-camera maps (tokens, profile assignment, probe snapshots)
    // are keys of the cameras' own settings (D870): no collection to declare.
    const deviceSettings = this.deviceSettings()

    // Decoder placement resolver removed: the `decoder` cap is now a
    // singleton (phase 2g+). The capability registry resolves the one
    // active provider per node; no per-device decoder-node routing.
    const rtspProvider = this.brokerManager.getRtspRestreamProvider()

    // Load persisted RTSP state from the addon settings store via the durable
    // `state()` handles (same keys/shapes the persisters below write through).
    const brokerManager = this.brokerManager
    const rtspTokens = rtspTokensMirror(deviceSettings, this.ctx.logger)
    const rtspEnabledState = this.state<RtspEnabledBlob>('rtspEnabled', RtspEnabledSchema, {})
    try {
      await hydratePersistedRtspState({
        tokensMirror: rtspTokens,
        enabledState: rtspEnabledState,
        loadTokens: (tokens) => brokerManager.loadPersistedTokens(tokens),
        loadEnabled: (states) => rtspProvider.loadPersistedEnabled(states),
        logger: this.ctx.logger,
      })
    } catch (err: unknown) {
      // An EMPTY store is first boot and does not throw; a store that could not
      // be asked does, and the token writer then refuses (it was never loaded).
      this.ctx.logger.warn('Failed to load persisted RTSP state - tokens will not be written', {
        meta: { error: errMsg(err) },
      })
    }

    // Cameras whose tokens EXIST in the keychain but cannot be read right now are
    // blocked for token writes only (the mirror never writes or overwrites them);
    // every stream is still served. An alert says why, and the tokens come back
    // without a restart once the keychain resolves (D870).
    this.startTokenRecovery(rtspTokens, brokerManager)

    rtspProvider.setTokenPersister(async (tokens) => {
      // MERGE, never replace — and with one row per broker that is now the
      // shape of the write rather than a discipline on top of it. `tokens`
      // holds ONLY the brokers currently registered with the listen server; a
      // broker that was later `unregisterRestreamer`-ed disappears from this
      // map. Replacing the set would erase its persisted token, turning an
      // external NVR/recording URL into a dead 404 on the next idle/reboot.
      // The contract is "a token is stable forever per (deviceId, camStreamId)
      // unless explicitly regenerated", so this only ever upserts.
      try {
        await rtspTokens.merge(mergeRtspTokens(rtspTokens, tokens))
        this.ctx.logger.info('Persisted RTSP tokens', {
          meta: { current: tokens.size },
        })
      } catch (err: unknown) {
        this.ctx.logger.warn('Failed to persist RTSP tokens', {
          meta: { error: errMsg(err) },
        })
      }
    })

    rtspProvider.setEnabledPersister((states) => {
      const obj: Record<string, boolean> = {}
      for (const [k, v] of states) obj[k] = v
      rtspEnabledState.set(obj).catch((err: unknown) => {
        this.ctx.logger.warn('Failed to persist RTSP enabled states', {
          meta: { error: errMsg(err) },
        })
      })
    })

    // Device overrides (per-profile pre-buffer, debug flags, derived
    // streams) — whole-object durable handle so NO field is ever dropped.
    // The previous hand-rolled persister silently omitted `derivedStreams`,
    // which made derived streams vanish on every restart.
    const deviceOverridesState = this.state<DeviceOverridesMap>(
      'deviceOverrides',
      DeviceOverridesMapSchema,
      {},
    )
    try {
      const obj = await deviceOverridesState.get()
      const overrides = new Map<number, DeviceOverride>()
      for (const [rawKey, ov] of Object.entries(obj)) {
        const id = Number(rawKey)
        if (Number.isInteger(id)) overrides.set(id, ov)
      }
      this.brokerManager.loadPersistedDeviceOverrides(overrides)
      this.ctx.logger.info('Loaded persisted device overrides', {
        meta: { overrideCount: overrides.size },
      })
    } catch (err) {
      this.ctx.logger.warn('Failed to load device overrides', {
        meta: { error: errMsg(err) },
      })
    }

    this.brokerManager.setDeviceOverridePersister((overrides) => {
      const obj: DeviceOverridesMap = {}
      for (const [deviceId, ov] of overrides) obj[`${deviceId}`] = ov
      deviceOverridesState.set(obj).catch((err: unknown) => {
        this.ctx.logger.warn('Failed to persist device overrides', {
          meta: { error: errMsg(err) },
        })
      })
    })

    // Profile-map persistence: load on boot, persist on every mutation —
    // through a durable handle (whole-object Zod round-trip).
    //
    // The persister is wired BEFORE the load: `loadPersistedProfileMap` prunes
    // devices the registry no longer knows, and that prune has to be written
    // back — with the old ordering it mutated memory only and the blob served
    // the deleted ids again at the next boot.
    const profileMap = profileMapMirror(deviceSettings, this.ctx.logger)
    const profileMapPersister: ProfileMapPersister = (assignments) => {
      // REPLACE, deliberately: `loadPersistedProfileMap` prunes cameras the
      // device registry no longer knows and that prune has to be written back.
      // The manager's map is the complete, authoritative set - the only kind of
      // caller allowed to drive a prune (D130). The mirror writes only the
      // cameras whose assignment changed and refuses before a load succeeded.
      const next = new Map<number, ProfileAssignment>()
      for (const [deviceId, assignment] of assignments) {
        next.set(deviceId, { map: { ...assignment.map }, auto: assignment.auto })
      }
      profileMap.replace(next).catch((err: unknown) => {
        this.ctx.logger.warn('Failed to persist profile map', {
          meta: { error: errMsg(err) },
        })
      })
    }
    this.brokerManager.setProfileMapPersister(profileMapPersister)

    try {
      const rows = await profileMap.load()
      const loaded = new Map<number, PersistedAssignment>()
      for (const [deviceId, val] of rows) {
        const map: Partial<Record<CamProfile, string>> = {}
        for (const profile of PROFILE_KEYS) {
          const v = val.map[profile]
          if (typeof v === 'string' && v.length > 0) map[profile] = v
        }
        loaded.set(deviceId, { map, auto: val.auto })
      }
      await this.brokerManager.loadPersistedProfileMap(loaded)
      this.ctx.logger.info('Loaded persisted profile map', {
        meta: { deviceCount: loaded.size },
      })
    } catch (err) {
      this.ctx.logger.warn('Failed to load profile map', {
        meta: { error: errMsg(err) },
      })
    }

    // Per-stream probe snapshots — durable so the settings "Probed" field
    // survives a hub restart (otherwise it shows "not yet probed" until the
    // stream is pulled again). Load on boot; the metrics loop flushes it.
    const probeSnapshots = probeSnapshotsMirror(deviceSettings, this.ctx.logger)
    this.probeSnapshots = probeSnapshots
    try {
      const rows = await probeSnapshots.load()
      const blob: ProbedSnapshotMap = Object.fromEntries(flattenByDevice(rows))
      this.brokerManager.loadProbeSnapshots(blob)
      this.ctx.logger.info('Loaded persisted probe snapshots', {
        meta: { streamCount: Object.keys(blob).length },
      })
    } catch (err) {
      this.ctx.logger.warn('Failed to load probe snapshots', {
        meta: { error: errMsg(err) },
      })
    }

    // `forgetDeviceHardware` (a device NUMBER changed hardware underneath —
    // `deviceManager.migrateDevice`): the manager drops what it owns; the two
    // durable handles it has no reach into are dealt with here. Token values are
    // upsert-only by contract (see `mergeRtspTokens`), so a migration is
    // the ONE caller allowed to delete them — the stream ids die with the old
    // hardware. The forced flush makes the probe-snapshot rows follow the
    // in-memory drop instead of waiting out the throttle interval.
    this.brokerManager.setDeviceHardwareForgetHook(async (deviceId) => {
      const rtspTokenRowsDeleted = (await rtspTokens.remove(deviceId)) ? 1 : 0
      this.flushProbeSnapshots(Date.now(), true)
      return { rtspTokenRowsDeleted }
    })

    // Start RTSP restream server
    await this.brokerManager.startRtspServer(this.config.rtspPort)

    // ── Catalog reconcile (PULL) ──────────────────────────────────────
    // The broker is the authority for its cam-stream registry: it PULLS each
    // camera's `stream-catalog` and reconciles, rather than relying on a push.
    // Trigger set: a start-up fetch, a configurable poll (the loss-is-a-bug
    // backstop for any missed event), and low-latency device / stream-params
    // events. The poll cadence is generous so its cost stays negligible; the
    // events make it feel instant.
    const reconcileAll = (reason: string): void => {
      void this.brokerManager?.reconcileAllCatalogs().catch((err: unknown) => {
        this.ctx.logger.warn('catalog reconcile failed', {
          meta: { reason, error: errMsg(err) },
        })
      })
    }
    const reconcileDevice = (deviceId: number, reason: string): void => {
      void this.brokerManager?.reconcileDeviceCatalog(deviceId).catch((err: unknown) => {
        this.ctx.logger.warn('device catalog reconcile failed', {
          tags: { deviceId },
          meta: { reason, error: errMsg(err) },
        })
      })
    }

    // NOT awaited: the bounded-retry startup pull reconciles against providers
    // that are themselves still probing at boot — each unanswered pull rides
    // the 12 s catalog timeout, so three passes held this addon's readiness
    // (cap registrations, the clientlog data-plane, the WebRTC server) hostage
    // for over a minute on a live hub (measured 85 s, 2026-08-15). Awaiting
    // bought a "no stale registry window" that a booting fleet cannot honour
    // anyway: catalogs can only converge once providers finish probing. The
    // reconcile runs to completion in the background instead; late brokers
    // still self-heal (`ensureBroker` on subscribe, `setWebrtcServer`
    // back-registration), and the 30 s poll + device events close any gap.
    void (
      this.brokerManager?.reconcileAllCatalogsAtStartup().catch((err: unknown) => {
        this.ctx.logger.warn('catalog startup reconcile failed', {
          meta: { error: errMsg(err) },
        })
      }) ?? Promise.resolve()
    )
    const reconcileMs = Math.max(5, this.config.catalogReconcileIntervalSec) * 1000
    this.catalogReconcileTimer = setInterval(() => reconcileAll('poll'), reconcileMs)

    this.subscribe({ category: EventCategory.DeviceRegistered }, (event) => {
      const deviceId = event.data.deviceId
      if (typeof deviceId !== 'number') return
      void this.brokerManager?.reconcileRegisteredDevice(deviceId).catch((err: unknown) => {
        this.ctx.logger.warn('device catalog reconcile failed', {
          tags: { deviceId },
          meta: { reason: 'device-registered', error: errMsg(err) },
        })
      })
    })
    subscribeDeviceRemoval(
      (filter, handler) => this.subscribe(filter, handler),
      () => this.deviceRemovalDeps(),
    )
    this.subscribe({ category: EventCategory.StreamParamsChanged }, (event) => {
      const deviceId = event.data.deviceId
      if (typeof deviceId !== 'number') return
      reconcileDevice(deviceId, 'stream-params-changed')
      // The catalog re-pull above updates the DESCRIPTORS. It does not touch a
      // live reader, and `kickReconnect` fires only when the URL changed — so
      // a camera whose encoder just restarted keeps whatever session it
      // happened to negotiate mid-restart. That is how 104 ended up muxing no
      // audio from a camera whose microphone was on (2026-08-07); see
      // `redialDeviceSources`.
      this.brokerManager?.redialDeviceSources(deviceId, 'stream-params-changed')
    })

    const cameraStreamsProvider = new CameraStreamsProvider(this.brokerManager)

    // Broker-integrated WebRTC server — subscribes directly to each
    // StreamBroker's onEncodedData() callback, zero ffmpeg re-encoding.
    //
    // `getIceServers` is the single per-session entry-point into the
    // `turn-provider` collection cap. `getTurnServers` is an array-output
    // method on a collection cap, so calling it without an `addonId`
    // hits the auto-mount's generic aggregate — the union of ICE servers
    // from every ENABLED `turn-provider` (cloudflare-turn, future coturn
    // / Twilio, …). There's NO per-device round-trip; the providers
    // cache at their own layer (cloudflare-turn refreshes ICE
    // credentials in the background ~12 h before the 24 h TTL), so the
    // per-session call costs a single cap dispatch. Without TURN
    // configured the call returns `[]` and WebRTC falls back to
    // host/srflx candidates.
    const turnApi = this.ctx.api as {
      turnProvider?: {
        getTurnServers: {
          query: (input?: object) => Promise<
            readonly {
              urls: string | string[]
              username?: string
              credential?: string
            }[]
          >
        }
      }
    }
    const intercomApi = this.ctx.api.intercom
    const webrtcServer = new BrokerWebrtcServer({
      logger: this.ctx.logger.child('webrtc'),
      // Talk-back (D771): a trusted caller's peer audio → the device speaker,
      // through the intercom cap's push-talk triple (the HomeKit path).
      talkbackIntercom: {
        startTalkSession: async (deviceId) => {
          await intercomApi.startTalkSession.mutate({ deviceId })
        },
        pushTalkAudio: (frame) =>
          intercomApi.pushTalkAudio.mutate({
            deviceId: frame.deviceId,
            audioBase64: frame.audioBase64,
            codec: frame.codec,
            sampleRate: frame.sampleRate,
            channels: frame.channels,
            sequenceNumber: frame.sequenceNumber,
          }),
        endTalkSession: async (deviceId) => {
          await intercomApi.endTalkSession.mutate({ deviceId })
        },
      },
      getIceServers: async () => {
        if (!turnApi.turnProvider) return []
        // `getTurnServers` is a `turn-provider` COLLECTION-cap aggregate. When
        // NO provider is registered the transport short-circuits to `[]`
        // instantly (empty collection — see the `resolveEmptyCollection`
        // fast-path in parent-unowned-call.ts); TURN is optional (LAN /
        // public-IP viewers fall back to host/srflx). With ≥1 provider the
        // aggregate fans out across them as usual.
        try {
          const servers = await turnApi.turnProvider.getTurnServers.query()
          // The cap returns readonly entries; normalise to mutable shape
          // the werift session expects + drop entries with empty url lists.
          const out: {
            urls: string | string[]
            username?: string
            credential?: string
          }[] = []
          for (const s of servers) {
            if (!s.urls || (Array.isArray(s.urls) && s.urls.length === 0)) continue
            out.push({
              urls: Array.isArray(s.urls) ? [...s.urls] : s.urls,
              ...(s.username ? { username: s.username } : {}),
              ...(s.credential ? { credential: s.credential } : {}),
            })
          }
          this.ctx.logger.info('broker getIceServers resolved', {
            meta: {
              count: out.length,
              urls: out.map((s) => (Array.isArray(s.urls) ? s.urls[0] : s.urls)),
            },
          })
          return out
        } catch (err) {
          // Non-fatal — log + return empty so the session still gets
          // built (LAN-only / public-IP scenarios don't need TURN).
          this.ctx.logger.warn(
            'turnProvider.getTurnServers failed — session will start without TURN',
            {
              meta: { error: err instanceof Error ? err.message : String(err) },
            },
          )
          return []
        }
      },
      // Feed the AdaptiveController the device's latest client-reported
      // network conditions — packet-loss % AND the measured inbound rate —
      // over async tRPC. The broker runs in its own
      // addon-runner process, so it reads the hub-resident
      // NetworkQualityTracker via `ctx.api.networkQuality.getDeviceStats`
      // (a safe, idempotent query) and synthesizes the monotonic loss sample
      // locally (see BrokerWebrtcServer.startAdaptive). This lets the
      // benchmark "Network Simulation" presets drive the downgrade ladder
      // without inducing real RTCP loss. Only polled inside `startAdaptive`,
      // i.e. for `/adaptive` sessions; the RTCP Receiver-Report path
      // (`onReceiverReport`) drives the ladder independently.
      clientNetworkStats: async (deviceId) => {
        // Bound the poll: a transiently-undiscoverable provider makes the
        // broker-fallback discovery wait ~30s, which would stall the adaptive
        // loop. Abort at NETWORK_QUALITY_STATS_TIMEOUT_MS and treat as no sample.
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), NETWORK_QUALITY_STATS_TIMEOUT_MS)
        try {
          const stats = await this.ctx.api.networkQuality.getDeviceStats.query(
            { deviceId },
            { signal: ctrl.signal },
          )
          const client = stats?.client
          if (!client) return null
          return {
            packetLossPercent: client.packetLossPercent,
            // The fact the ladder used to discard. `estimatedBandwidthKbps`
            // is the client's own Δ bytesReceived / Δ timestamp on the
            // inbound video track — the only reported number that can see a
            // freeze, because a stream delivering nothing reports 0 % loss.
            estimatedBandwidthKbps: client.estimatedBandwidthKbps,
            lastUpdated: client.lastUpdated,
            rttMs: client.rttMs,
            ...(client.downlinkMbps !== undefined ? { downlinkMbps: client.downlinkMbps } : {}),
            ...(client.downlinkAgeMs !== undefined ? { downlinkAgeMs: client.downlinkAgeMs } : {}),
          }
        } catch {
          return null
        } finally {
          clearTimeout(timer)
        }
      },
      // Recorded playback over WebRTC: the RecordedFeeder reaches the recording
      // cap over tRPC (the broker runs in its own addon-runner process). Present ⇒
      // each session gets a TimelineSession; the feeder locates + reads segments here.
      locateRecordedSegment: (args) => this.ctx.api.recordingArchive.locateSegment.query(args),
      readRecordedSegmentBytes: async (args) =>
        (await this.ctx.api.recordingArchive.readSegmentBytes.query(args)).data,
      // CLIP playback over the SAME WebRTC session (D575): one bounded,
      // by-handle fetch of a whole compressed file, then every frame is
      // decoded in this process (D9/D18). `videoclips.readClipBytes` is an
      // OPTIONAL cap method — a provider that does not implement it throws,
      // and the clip source turns that into a named refusal the operator sees
      // rather than a frozen frame.
      readClipBytes: async (args) => {
        const res = await this.ctx.api.videoclips.readClipBytes.query({
          deviceId: args.deviceId,
          clipId: args.clipId,
          // NAMED, always. This broker lives in the same addon as the
          // RECORDER's videoclips provider, and with no provider named the
          // in-process resolution handed the read to that sibling — which
          // implements the method only to explain that an analytics visit has
          // no file behind it. Every onboard clip died on that sentence
          // (3628, 2026-09-21): a flash of video, then nothing.
          // `provider` is the WHOLE pin, and it is now honoured on both paths:
          // the hub's mount (`pinnedProvider`) and — since D593 — the Moleculer
          // transport this call really travels on (`narrowToPinnedProvider`).
          //
          // A second field here was tried and was never read. This call leaves
          // the runner over Moleculer, which used to take `candidates[0]` of
          // every service exposing `videoclips.readClipBytes`: the recorder
          // ("an analytics visit has no file behind it"), then export-hap
          // ("was not minted by the HomeKit source") after a redeploy in a
          // different order — the same clip, two different wrong answers, with
          // the provider named twice over and nothing reading either field
          // (measured 2026-09-22). A pin belongs where the dispatch happens.
          provider: args.provider,
          ...(args.profile !== null ? { profile: args.profile } : {}),
        })
        return new Uint8Array(Buffer.from(res.base64, 'base64'))
      },
      // The clip STREAM's dial (D597): one cap call for a one-shot URL on the
      // provider's own loopback listener, then the broker dials it directly
      // — the restream precedent (`getStreamWithCodec`), one addon over. The
      // pin is the same pin `readClipBytes` learned to carry. A thrown error
      // is CLASSIFIED, never rethrown: a provider that predates the method
      // is `unavailable`, a clip-vocabulary refusal keeps its code.
      dialClipStream: async (args) => {
        try {
          const dial = await this.ctx.api.videoclips.dialClipStream.query({
            deviceId: args.deviceId,
            clipId: args.clipId,
            provider: args.provider,
            ...(args.profile !== null ? { profile: args.profile } : {}),
            // The session's negotiated audio codec (D600). Always sent, `none`
            // included: the mux is spawned once, before the first byte, so the
            // ask cannot arrive later — and a provider older than the field
            // ignores it and serves the video-only stream it always did.
            audio: args.audio,
          })
          return {
            kind: 'dialed',
            url: dial.url,
            expiresAtMs: dial.expiresAtMs,
            ...(typeof dial.served === 'string' ? { served: dial.served } : {}),
            ...(typeof dial.servedAudio === 'string' ? { servedAudio: dial.servedAudio } : {}),
            ...(typeof dial.audioReason === 'string' ? { audioReason: dial.audioReason } : {}),
          }
        } catch (err) {
          return dialAnswerFromError(err)
        }
      },
      // GOP byte-range read (D31 on the feeder path). Version-skew guard: this
      // broker may be deployed against a recording provider that predates
      // `readGopBytes` — degrade PER CALL to the whole-segment read (correct
      // bytes, worse read; never latched, so a transient RPC failure cannot
      // permanently downgrade the broker) and log the first downgrade; a
      // silent fallback here would read exactly like the byte-range design
      // working.
      readRecordedGopBytes: async (args) => {
        try {
          return await this.ctx.api.recordingArchive.readGopBytes.query({
            deviceId: args.deviceId,
            profile: args.profile,
            startMs: args.startMs,
            epochMs: args.epochMs,
          })
        } catch (err) {
          if (!this.gopReadFallbackLogged) {
            this.gopReadFallbackLogged = true
            this.ctx.logger.warn(
              'stream-broker: recording.readGopBytes failed — degrading this scrub read to the whole segment (logged once)',
              {
                tags: { deviceId: args.deviceId },
                meta: { error: errMsg(err) },
              },
            )
          }
          const whole = await this.ctx.api.recordingArchive.readSegmentBytes.query({
            deviceId: args.deviceId,
            profile: args.profile,
            startMs: args.startMs,
          })
          return {
            data: whole.data,
            gopStartMs: args.startMs,
            gopDurMs: args.segmentDurMs,
          }
        }
      },
      // The demuxers spawn one ffmpeg per fragment — use the operator-configured
      // binary (the ffmpeg wiring loaded it above, and a re-resolve updates it).
      resolveFfmpegPath: () => {
        if (this.ffmpegBinaryPath === null) {
          this.ffmpegWiring?.request('a recorded-playback demux needed ffmpeg')
        }
        return this.ffmpegBinaryPath
      },
    })
    // Wire the server into the broker manager so it registers/unregisters
    // brokers as camera profiles come and go.
    this.brokerManager.setWebrtcServer(webrtcServer)
    // Retain for onShutdown teardown (closes PeerConnections → frees ICE sockets).
    this.webrtcServer = webrtcServer

    const webrtcSessionProvider = new WebrtcSessionProvider(webrtcServer, this.brokerManager)

    // Per-broker metrics snapshot emission (~1 Hz). UI dashboards
    // subscribe to `stream-broker.metrics-snapshot` and drive their
    // overlays from event payloads instead of polling the cap.
    this.metricsSnapshotTimer = setInterval(
      () => this.emitBrokerMetricsSnapshot(),
      BROKER_METRICS_SNAPSHOT_INTERVAL_MS,
    )

    this.stopBrokerMemReport = startBrokerMemReport({
      logger: this.ctx.logger,
      manager: this.brokerManager,
      webrtcSessions: () => webrtcServer.getSessionCount(),
      sessionMem: () => webrtcServer.getSessionMemReadings(),
    })

    // Widget bundle contribution — declares the per-camera
    // stream-broker panel as an addon-shipped widget. Admin-ui's
    // <WidgetRegistryProvider> registers the Module Federation remote
    // at /api/addon-widgets/stream-broker/remoteEntry.js?v=<mtime>,
    // then loads the exposed `./widgets` module; the form-builder /
    // dashboard / device-tab dispatcher mounts each widget via
    // <WidgetSlot widgetId="stream-broker/stream-broker-panel" deviceId=…/>.
    const widgetsProvider: IAddonWidgetsSourceProvider = {
      listWidgets: async () => [
        {
          tab: 'device-tab',
          label: 'Stream Brokers',
          preAuth: false,
          kind: 'remote' as const,
          remote: {
            remoteName: 'addon_stream_broker_widgets',
            exposedModule: './widgets',
            componentKey: 'stream-broker-panel',
          },
          stableId: 'stream-broker-panel',
          description: 'Per-camera stream broker panel with adaptive controls.',
          icon: 'radio',
          bundle: 'remoteEntry.js',
          hosts: ['device-tab', 'dashboard'] as const,
          requires: { deviceContext: true, integrationContext: false },
          defaultSize: 'lg' as const,
          allowedSizes: ['md', 'lg', 'xl'] as const,
          defaultColumns: 8,
          defaultRows: 2,
        },
        {
          tab: 'device-tab',
          label: 'FFmpeg Parameters',
          preAuth: false,
          kind: 'remote' as const,
          remote: {
            remoteName: 'addon_stream_broker_widgets',
            exposedModule: './widgets',
            componentKey: 'ffmpeg-params',
          },
          stableId: 'ffmpeg-params',
          description: 'Per-camera FFmpeg encoding parameter editor.',
          icon: 'settings',
          bundle: 'remoteEntry.js',
          hosts: ['device-tab'] as const,
          requires: { deviceContext: true, integrationContext: false },
          defaultSize: 'md' as const,
          allowedSizes: ['md', 'lg'] as const,
          defaultColumns: 6,
          defaultRows: 2,
        },
      ],
    }

    this.ctx.logger.info('Stream broker manager initialized')

    // Authenticated client-log ingest: the connected viewer batches its in-app
    // logs and POSTs them to `/addon/stream-broker/clientlog`; each entry is
    // forwarded to the hub logger (meta.source) so it lands in winston + the
    // admin logs query. Lets us debug the app (live/playback/scrub) from the hub.
    try {
      const clientLogHandler = createClientLogIngest((entries, source) => {
        for (const e of entries) {
          const m = `[${source}:${e.level}:${e.scope}] ${e.msg}`
          const deviceId = entryDeviceId(e)
          const opts = {
            meta: { source, level: e.level, clientTs: e.ts, data: e.data },
            ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
          }
          // NB: the hub's winston destination drops `debug`, so client `debug`
          // entries are logged at `info` (the client level is in the message +
          // meta.level) — otherwise the app's verbose diagnostics never persist.
          if (e.level === 'error') this.ctx.logger.error(m, opts)
          else if (e.level === 'warn') this.ctx.logger.warn(m, opts)
          else this.ctx.logger.info(m, opts)
        }
      })
      await this.ctx.dataPlane?.serve({
        prefix: 'clientlog',
        access: 'authenticated',
        handler: clientLogHandler,
      })
      this.ctx.logger.info('stream-broker: client-log ingest served')
    } catch (err: unknown) {
      this.ctx.logger.warn('stream-broker: client-log ingest failed to serve', {
        meta: { error: errMsg(err) },
      })
    }

    // `webrtc-session` is a singleton cap. The broker registers its builtin
    // (werift) provider unconditionally; another addon could register a
    // second provider for the same cap, and the operator selects the
    // active one via the framework's singleton provider preference
    // (capabilities.setPreference → `capabilities.singleton.webrtc-session`),
    // i.e. the system Capabilities UI — no broker-specific setting.
    this.removalHook = createBrokerRemovalHook({
      logger: this.ctx.logger,
      retractDevice: async (deviceId) => {
        await retractRemovedDevice(deviceId, this.deviceRemovalDeps())
      },
      dropDeviceOverride: (deviceId) => brokerManager.dropDeviceOverride(deviceId),
      overrideDeviceIds: () => brokerManager.listDeviceOverrideIds(),
    })
    const registrations: ProviderRegistration[] = [
      { capability: streamBrokerCapability, provider: this.brokerManager },
      {
        capability: cameraStreamsCapability,
        provider: cameraStreamsProvider,
      },
      {
        capability: webrtcSessionCapability,
        provider: webrtcSessionProvider,
      },
      { capability: addonWidgetsSourceCapability, provider: widgetsProvider },
      logChannelsRegistration,
      loadContributionRegistration,
      // A deleted camera's streams, assignments and override are removed with
      // it (D870) - told by device-manager, caught up from its tombstones.
      { capability: deviceRemovalHookCapability, provider: this.removalHook },
    ]
    return registrations
  }

  /**
   * Watch the cameras whose restream tokens are held but unreadable (D870): no
   * restream URL is registered for them (the manager's gate), an alert says so,
   * and when a value resolves ONLY that camera's restreamers are registered with
   * the stored tokens - no teardown. A lost secret is released after two
   * consistent reads and gets new, persisted tokens.
   */
  private startTokenRecovery(
    mirror: DeviceKeyMirror<RtspTokensOfDevice>,
    brokerManager: StreamBrokerManager,
  ): void {
    const secrets = this.ctx.secrets
    if (secrets === undefined) {
      // No keychain handle: nothing can be classified or recovered, so nothing may
      // be blocked either - never a silent block.
      if (mirror.heldDevices().size > 0) {
        this.ctx.logger.error('restream tokens look held but this addon has no keychain access', {
          meta: { cameras: mirror.heldDevices().size },
        })
      }
      return
    }
    // The gate is set BEFORE any broker registers.
    brokerManager.setRestreamGate((deviceId) => mirror.isBlocked(deviceId))
    if (mirror.heldDevices().size === 0) return
    const alertId = (deviceId: number): string => `stream-broker-tokens:${deviceId}`
    const warn = (what: string) => (err: unknown) =>
      this.ctx.logger.warn(what, { meta: { error: errMsg(err) } })
    const recovery = new TokenRecovery({
      mirror,
      secrets,
      logger: this.ctx.logger,
      alerts: {
        raise: async ({ deviceId, kind, message }) => {
          const now = Date.now()
          await this.ctx.api.alerts.emit
            .mutate({
              id: alertId(deviceId),
              category: 'streams',
              severity: 'warning',
              title:
                kind === 'missing'
                  ? 'New RTSP restream URLs issued'
                  : 'RTSP restream URLs unavailable',
              message,
              status: 'active',
              read: false,
              createdAt: now,
              updatedAt: now,
              source: { type: 'device', id: String(deviceId) },
              metadata: { deviceId, kind },
            })
            .catch(warn('could not raise the restream-token alert'))
        },
        clear: async (deviceId) => {
          await this.ctx.api.alerts.update
            .mutate({
              alertId: alertId(deviceId),
              patch: { status: 'completed', updatedAt: Date.now() },
            })
            .catch(warn('could not clear the restream-token alert'))
        },
      },
      onRegister: async (tokens, cameras) => {
        brokerManager.loadPersistedTokens(flattenByDevice(tokens))
        for (const deviceId of cameras) brokerManager.registerRestreamersForDevice(deviceId)
      },
    })
    recovery.start()
    const unsubscribe = secrets.onChange((ref) => {
      if (ref.startsWith('secret://stream-broker/device/')) void recovery.tick()
    })
    this.ctx.addDisposer(() => {
      recovery.stop()
      unsubscribe()
    })
  }

  override async onHubReachable(): Promise<void> {
    // Catch up on deletions this node missed while it was down (D870). Driven
    // by device-manager's tombstones only - never by a camera being absent.
    const removalHook = this.removalHook
    if (removalHook === null) return
    this.ctx.addDisposer(
      armRemovalReconcile({
        api: this.ctx.api,
        logger: this.ctx.logger,
        remove: (input) => removalHook.onDeviceRemoved(input),
      }),
    )
  }

  protected async onShutdown(): Promise<void> {
    this.logChannels?.stop()
    this.logChannels = null
    this.stopBrokerMemReport?.()
    this.stopBrokerMemReport = null
    this.loopStallMonitor?.stop()
    this.loopStallMonitor = null
    // Final probe-map flush before teardown so the "Probed" field is current
    // after a graceful restart (deploy/respawn). Best-effort; brokerManager is
    // still alive here.
    this.flushProbeSnapshots(Date.now(), true)
    if (this.metricsSnapshotTimer) {
      clearInterval(this.metricsSnapshotTimer)
      this.metricsSnapshotTimer = null
    }
    if (this.catalogReconcileTimer) {
      clearInterval(this.catalogReconcileTimer)
      this.catalogReconcileTimer = null
    }
    // Close the WebRTC server FIRST: it iterates live sessions and closes
    // each PeerConnection, which is the only thing that releases the werift
    // ICE UDP sockets. destroyAll() handles brokers + RTSP but NOT these —
    // leaving them open leaks the sockets past process exit and wedges the
    // next respawned runner's ICE agent (DTLS never connects until a clean
    // hub restart). Wrapped so a teardown error can't block broker cleanup.
    try {
      await this.webrtcServer?.stop()
    } catch (err) {
      this.ctx?.logger?.warn?.('WebRTC server stop failed during shutdown', {
        meta: { error: errMsg(err) },
      })
    }
    this.webrtcServer = null
    await this.brokerManager?.destroyAll()
    this.brokerManager = null
  }

  /**
   * A device was PERMANENTLY removed (`DeviceUnregistered`).
   *
   * Retracts its cam-streams AND purges its profile-slot assignments.
   * `preserveAssignments` alone is the provider-restart contract — the streams
   * come back and the operator's manual slot choices must survive — but a
   * DELETED device that keeps its assignments stays in `listAllProfileSlots`
   * for the life of the process and is written straight back into the
   * persisted `profileMap` blob, so it returns at every boot. Live ids
   * 3217/3218 outlived their cameras exactly that way.
   */
  private deviceRemovalDeps(): DeviceRemovalDeps {
    return {
      retractDevice: async (deviceId, opts) => {
        await this.brokerManager?.retractDevice(deviceId, opts)
      },
      logger: this.ctx.logger,
    }
  }

  /**
   * Emit one `stream-broker.metrics-snapshot` event per active broker.
   * BrokerStats already aggregates everything UI consumers need
   * (status, fps, bitrate, codec, subscriber count). Skipped when no
   * brokers are registered so quiet dev runs don't emit noise.
   */
  private emitBrokerMetricsSnapshot(): void {
    const manager = this.brokerManager
    const eventBus = this.ctx.eventBus
    if (!manager || !eventBus) return
    const brokers = manager.getBrokerInstances()
    if (brokers.length === 0) return
    const rawNodeId = this.ctx.kernel.localNodeId ?? this.ctx.id
    const nodeId = rawNodeId.includes('/') ? rawNodeId.split('/')[0]! : rawNodeId
    const timestamp = Date.now()
    const seenBrokerIds = new Set<string>()
    for (const broker of brokers) {
      const stats = broker.getStats()
      // brokerId encoded as `<deviceId>/<profile>` (StreamBroker.deviceId
      // field is overloaded to mean brokerId — see broker constructor).
      const brokerId = broker.deviceId
      seenBrokerIds.add(brokerId)
      // Persist the latest probe (no-op unless streaming) so the per-stream
      // "Probed" settings field stays populated after the stream goes idle.
      manager.recordProbeSnapshot(brokerId, stats, timestamp)
      const slash = brokerId.indexOf('/')
      const deviceId = slash > 0 ? Number(brokerId.slice(0, slash)) : Number(brokerId)
      const profile = slash > 0 ? brokerId.slice(slash + 1) : ''
      if (!Number.isFinite(deviceId)) continue
      // Snapshot-equality skip — same pattern as pipeline-runner's
      // emitMetricsSnapshot. Idle broker → bytewise-identical payload
      // → no emit. Quiet brokers still emit every
      // BROKER_METRICS_HEARTBEAT_MS so the UI's "broker reachable"
      // chip doesn't go stale.
      //
      // Strip monotonic counters before equality — `uptimeMs` ticks
      // every second on every broker, `totalBytes` / `packetCount`
      // grow continuously while streaming, so the raw JSON of stats
      // always differs and the defer never fires. We only want
      // observable-state changes (status, fps, subscribers, codec,
      // bitrate). The full payload still goes on the bus when an
      // emit fires; the strip only affects the dedup key.
      const json = stableSnapshotKey(stats, ['uptimeMs', 'totalBytes', 'packetCount'])
      const prev = this.lastEmittedBrokerSnapshot.get(brokerId)
      const heartbeatDue = !prev || timestamp - prev.emittedAt >= BROKER_METRICS_HEARTBEAT_MS
      if (prev && prev.json === json && !heartbeatDue) continue
      this.lastEmittedBrokerSnapshot.set(brokerId, {
        json,
        emittedAt: timestamp,
      })
      eventBus.emit(
        createEvent(
          EventCategory.StreamBrokerMetricsSnapshot,
          { type: 'device', id: deviceId, nodeId },
          { brokerId, deviceId, profile, nodeId, stats, timestamp },
        ),
      )
    }
    // Drop cache entries for brokers that no longer exist (camera
    // detached, stream profile unassigned). Cheap because brokers
    // is the canonical truth and seenBrokerIds is a Set.
    if (this.lastEmittedBrokerSnapshot.size > seenBrokerIds.size) {
      for (const cachedId of this.lastEmittedBrokerSnapshot.keys()) {
        if (!seenBrokerIds.has(cachedId)) this.lastEmittedBrokerSnapshot.delete(cachedId)
      }
    }
    this.flushProbeSnapshots(timestamp, false)
  }

  /**
   * The per-device settings, as the broker persists through them. Resolved
   * reads/writes (keychain markers never reach this code), and a context with
   * no settings is a broker that cannot start.
   */
  private deviceSettings(): BrokerDeviceSettings {
    const settings = this.ctx.settings
    if (settings === undefined) throw new Error('stream-broker: device settings are not available')
    return settings
  }

  /**
   * Persist the manager's probe map to the durable handle. Throttled to
   * PROBE_SNAPSHOTS_PERSIST_INTERVAL_MS (or `force` on shutdown) so a busy
   * streaming fleet doesn't drive a write per metrics tick.
   */
  private flushProbeSnapshots(now: number, force: boolean): void {
    const store = this.probeSnapshots
    const manager = this.brokerManager
    if (!store || !manager) return
    if (!force && now - this.lastProbePersistAt < PROBE_SNAPSHOTS_PERSIST_INTERVAL_MS) return
    this.lastProbePersistAt = now
    // REPLACE: the manager's probe map is the authority for which brokers exist.
    // A camera it no longer holds loses its key; a camera whose snapshots did
    // not change is not written.
    store.replace(groupByDevice(manager.getProbeSnapshots())).catch((err: unknown) => {
      this.ctx.logger.warn('Failed to persist probe snapshots', {
        meta: { error: errMsg(err) },
      })
    })
  }

  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'stream-broker-settings',
          title: 'Stream Broker',
          columns: 3,
          fields: [
            {
              type: 'number',
              key: 'defaultPreBufferSec',
              label: 'Pre-buffer Duration',
              description:
                'Seconds of history a warm stream keeps. This is the ONLY history setting in the system: an event recording and a detection decode are both served from it and neither configures a window of its own — each is handed this much or whatever the stream has actually been warm for, whichever is less. It costs memory on whichever node ingests the camera, roughly this many seconds of that stream’s bitrate. Turn the pre-buffer on or off per camera stream in the camera’s Streams settings.',
              min: PREBUFFER_MIN_SEC,
              max: PREBUFFER_MAX_SEC,
              step: 1,
              default: DEFAULT_PREBUFFER_SEC,
              unit: 's',
            },
            {
              type: 'number',
              key: 'rtspPort',
              label: 'RTSP Restream Port',
              description: 'Port for the RTSP restream server. Requires restart.',
              min: 1024,
              max: 65535,
              step: 1,
              default: 8554,
            },
            {
              type: 'select',
              key: 'hwaccel',
              label: 'Transcode hardware acceleration',
              description:
                'Per-node decode/encode hwaccel for the WebRTC/restream transcode path. "Software (copy)" is the safe default (decodes every HEVC source); a concrete backend is resolved from this node’s own hardware. Per-node because hardware differs per node.',
              options: [...FFMPEG_HW_ACCEL_SETTINGS].map((s) => ({
                value: s,
                label: hwAccelOptionLabel(s),
              })),
              default: 'copy',
              perNode: true,
            },
            {
              type: 'text',
              key: 'binaryPath',
              label: 'ffmpeg binary path (override)',
              description:
                'Optional per-node override for the ffmpeg binary. Leave empty to auto-provision a portable static ffmpeg on this node (recommended).',
              placeholder: 'ffmpeg',
              default: '',
              perNode: true,
            },
            {
              type: 'number',
              key: 'joinBurstMaxSpanMs',
              label: 'Join-burst bound',
              description:
                'Cluster-wide default for how much recent video a client joining an RTSP restream may be handed at once. Over this the burst is withheld whole — a window cut from the ring no longer starts at a keyframe, so it cannot be decoded — and the client joins at the next keyframe instead. 2000 ms was measured: it keeps a normal short-GOP camera’s instant start and cuts the tail that a real-time re-emitter forwards to its peer as jitter. Override per camera stream on a camera whose keyframe interval is longer. WebRTC viewers are exempt.',
              min: JOIN_BURST_MIN_SPAN_MS,
              max: JOIN_BURST_MAX_SPAN_LIMIT_MS,
              step: 250,
              default: DEFAULT_PRIME_BURST_BOUND.maxSpanMs,
              unit: 'ms',
            },
            {
              type: 'number',
              key: 'catalogReconcileIntervalSec',
              label: 'Catalog Reconcile Interval',
              description:
                'How often the broker re-pulls every camera’s stream catalog (reconcile backstop)',
              min: 5,
              max: 300,
              step: 5,
              default: 30,
              unit: 's',
            },
          ],
        },
      ],
    })
  }
}

export default StreamBrokerAddon
