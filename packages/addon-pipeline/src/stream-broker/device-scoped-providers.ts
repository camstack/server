import { makeSourceBrokerId, rankStreams } from '@camstack/types'
import type {
  CameraStream,
  ProfileSlot,
  CamProfile,
  RtspRestreamEntry,
  ProfileRtspEntry,
  WebrtcClientHints,
  WebrtcStreamChoice,
  WebrtcStreamTarget,
  WebrtcSessionDebug,
  EncodeProfile,
  PickedCamStream,
  PickStreamPreferences,
  PickStreamRequirements,
  StreamCodec,
  BrokerConsumerAttribution,
} from '@camstack/types'
import type { StreamBrokerManager } from './stream-broker/stream-broker-manager.js'
import { withSourceResolution } from './encode-profile-resolver.js'
import { WEBRTC_FALLBACK_PROFILE } from './webrtc/webrtc-fallback-profile.js'

// ── pickStream helpers ───────────────────────────────────────────────

/** Canonicalise a stream codec string against the cap enum. */
function canonicalCodec(raw: string | undefined): StreamCodec | null {
  if (!raw) return null
  const lower = raw.toLowerCase()
  if (lower === 'hevc') return 'hevc'
  if (lower === 'h265') return 'h265'
  if (lower === 'h264') return 'h264'
  if (lower === 'av1') return 'av1'
  if (lower === 'mjpeg') return 'mjpeg'
  if (lower === 'vp8') return 'vp8'
  if (lower === 'vp9') return 'vp9'
  return null
}

/** Two codecs match if they normalise to the same value OR are h265↔hevc aliases. */
function codecMatches(streamCodec: string | undefined, accept: readonly StreamCodec[]): boolean {
  const c = canonicalCodec(streamCodec)
  if (!c) return false
  if (accept.includes(c)) return true
  // H.265 and HEVC are the same payload, naming varies by SDK / probe.
  if ((c === 'h265' && accept.includes('hevc')) || (c === 'hevc' && accept.includes('h265'))) {
    return true
  }
  return false
}

/**
 * Whether a consumer may pick this stream at all.
 *
 * `autoEligible: false` is how a publication says "I am not a camera stream a
 * chooser may land on" — set by exactly two publishers, both broker-owned: a
 * `derived:*`, and the PRIVATE egress the ffmpeg primitive publishes for
 * `publishLocally`. Picking the latter is the co-tenant hazard D67 exists to
 * end, and it happened: Alexa's second session on 587 logged "bypassing
 * transcode via cameraStreams.pickStream {selectedCamStreamId=egress:08e7…}"
 * and attached to another session's egress holding NO refcount on it — one
 * release away from having the stream pulled out from under it. `excludeDerived`
 * filters the `derived:` prefix and knew nothing about the egress; this gate is
 * unconditional, because no caller flag can make a private egress selectable.
 */
function isSelectable(stream: CameraStream): boolean {
  return stream.autoEligible !== false
}

const PROVIDER_PREFIX_DEFAULTS: readonly string[] = ['native:']

/**
 * Device-scoped facade over the broker's cam-stream registry.
 * Implements `cameraStreamsCapability` (reads only — every mutation
 * lives on the system-scope `stream-broker` cap).
 */
export class CameraStreamsProvider {
  constructor(private readonly manager: StreamBrokerManager) {}

  async getCameraStreams(input: { deviceId: number }): Promise<readonly CameraStream[]> {
    return this.manager.getCameraStreamsForDevice(input.deviceId)
  }

  async getBrokerStreams(input: { deviceId: number }): Promise<readonly ProfileSlot[]> {
    return this.manager.getProfileSlotsForDevice(input.deviceId)
  }

  async getRtspEntries(input: {
    deviceId: number
    hostname?: string
  }): Promise<readonly RtspRestreamEntry[]> {
    return this.manager.getRtspEntriesForDevice(input.deviceId, input.hostname)
  }

  async getProfileRtspEntries(input: {
    deviceId: number
    hostname?: string
  }): Promise<readonly ProfileRtspEntry[]> {
    return this.manager.getProfileRtspEntriesForDevice(input.deviceId, input.hostname)
  }

  /**
   * Pick the best source camStream for the caller's decode constraints.
   * Returns `null` when nothing matches — the caller falls back to its
   * existing path (derived-broker transcode, profile-slot pick, etc).
   *
   * Generalised from Alexa's `tryResolveDirectH264Target`: every broker
   * consumer with codec restrictions (Echo decodes only H.264, HomeKit
   * Secure Video prefers H.264 baseline, browsers without HEVC
   * hardware…) needs the same "is there a non-transcoded sibling
   * stream I should dial?" decision, so it lives on the cap.
   */
  async pickStream(input: {
    deviceId: number
    // INFERRED from the cap's own schemas, never re-spelled. The hand-written
    // copy that used to stand here drifted the moment the schema grew
    // `maxHeight` and `allowTranscode`, and a shape re-typed beside the one
    // that validates it is the same defect as a second scorer: two statements
    // of one truth, where only one of them is checked.
    requirements: PickStreamRequirements
    preferences?: PickStreamPreferences
  }): Promise<PickedCamStream | null> {
    const streams = await this.manager.getCameraStreamsForDevice(input.deviceId)
    if (streams.length === 0) {
      this.manager.getLogger?.()?.info('camera-streams: pickStream — no streams for device', {
        tags: { deviceId: input.deviceId },
        meta: { deviceId: input.deviceId, requirements: input.requirements },
      })
      return null
    }

    const requirements = input.requirements
    const preferences = input.preferences
    const excludeDerived = requirements.excludeDerived !== false
    const accept = requirements.acceptCodecs ?? []
    const minHeight = requirements.minHeight ?? 0
    const minWidth = requirements.minWidth ?? 0
    const maxHeight = requirements.maxHeight ?? Number.POSITIVE_INFINITY
    const allowTranscode = requirements.allowTranscode === true

    // The CODEC filter moved into the ranking, which is what lets one picker
    // answer both "a stream I can forward untouched" and "the best stream,
    // transcoding if I must" — see `rankStreams`. The size and derived gates
    // stay here: they are hard constraints, and a constraint is not an order.
    const candidates = streams.filter((s) => {
      if (!isSelectable(s)) return false
      if (excludeDerived && s.camStreamId.startsWith('derived:')) return false
      if (!allowTranscode && accept.length > 0 && !codecMatches(s.codec, accept)) return false
      if ((s.resolution?.height ?? 0) < minHeight) return false
      if ((s.resolution?.width ?? 0) < minWidth) return false
      if ((s.resolution?.height ?? 0) > maxHeight) return false
      return true
    })
    if (candidates.length === 0) {
      this.manager.getLogger?.()?.info('camera-streams: pickStream — no matching candidates', {
        tags: { deviceId: input.deviceId },
        meta: {
          deviceId: input.deviceId,
          requirements: input.requirements,
          streams: streams.map((s) => ({
            camStreamId: s.camStreamId,
            codec: s.codec,
            resolution: s.resolution,
          })),
        },
      })
      return null
    }

    // Sibling-codec gate — only "pick a bypass" when the natural pick
    // would have hit one of the rejected codecs. Skips the optimisation
    // for devices that don't need it.
    const requireSibling = requirements.requireSiblingCodec ?? []
    if (requireSibling.length > 0) {
      const hasSibling = streams.some((s) => {
        if (!isSelectable(s)) return false
        if (s.camStreamId.startsWith('derived:')) return false
        return codecMatches(s.codec, requireSibling)
      })
      if (!hasSibling) {
        this.manager
          .getLogger?.()
          ?.info('camera-streams: pickStream — no sibling codec, skipping bypass', {
            tags: { deviceId: input.deviceId },
            meta: {
              deviceId: input.deviceId,
              requireSibling,
              streams: streams.map((s) => ({
                camStreamId: s.camStreamId,
                codec: s.codec,
              })),
            },
          })
        return null
      }
    }

    // The operator's rule: never name a stream a consumer cannot dial. A
    // source with no slot has no restream, so an exporter can do nothing with
    // it — and without this each consumer discovers the dead end for itself.
    // NOT the default: the broker picks through here to decide which source to
    // BIND to a slot, and it must see the unbound ones or it could never bind
    // them.
    const profileBoundOnly = requirements.requireProfileBound === true
    if (profileBoundOnly) {
      const boundIds = new Set(
        this.manager
          .getProfileSlotsForDevice(input.deviceId)
          .map((s) => s.sourceCamStreamId)
          .filter((id): id is string => id !== null),
      )
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        if (!boundIds.has(candidates[i]!.camStreamId)) candidates.splice(i, 1)
      }
      if (candidates.length === 0) {
        this.manager
          .getLogger?.()
          ?.info('camera-streams: pickStream — no candidate is bound to a profile', {
            tags: { deviceId: input.deviceId },
            meta: { deviceId: input.deviceId, bound: [...boundIds] },
          })
        return null
      }
    }

    const preferredProviders = preferences?.preferredProviders ?? PROVIDER_PREFIX_DEFAULTS
    const resolutionPreference = preferences?.resolutionPreference ?? 'highest'

    // Provider rank: lower is better. Streams whose camStreamId starts
    // with the earliest preferred prefix win. Unmatched streams sit at
    // `preferredProviders.length` (last).
    const providerRank = (camStreamId: string): number => {
      for (let i = 0; i < preferredProviders.length; i += 1) {
        if (camStreamId.startsWith(preferredProviders[i]!)) return i
      }
      return preferredProviders.length
    }

    // ONE ranking, shared with every consumer that scores streams. It used to
    // be inline here, and an exporter that needed a term this could not express
    // grew a second scorer of its own — which is how a camera ended up serving
    // an Echo a picture below Amazon's documented floor.
    const ranked = rankStreams(
      candidates.map((s) => ({
        camStreamId: s.camStreamId,
        ...(s.codec === undefined ? {} : { codec: s.codec }),
        ...(s.resolution ? { height: s.resolution.height, width: s.resolution.width } : {}),
      })),
      {
        acceptCodecs: accept,
        allowTranscode,
        preferredProviders,
        resolutionPreference,
        ...(preferences?.targetHeight === undefined
          ? {}
          : { targetHeight: preferences.targetHeight }),
      },
    )
    if (ranked === null) return null
    const winner = candidates.find((s) => s.camStreamId === ranked.candidate.camStreamId)
    if (winner === undefined) return null

    const reasonParts: string[] = []
    reasonParts.push(`codec=${winner.codec ?? 'unknown'}`)
    if (winner.resolution)
      reasonParts.push(`res=${winner.resolution.width}x${winner.resolution.height}`)
    reasonParts.push(`provider=${providerRank(winner.camStreamId)}`)
    reasonParts.push(ranked.transcodes ? 'transcode' : 'passthrough')
    if (preferences?.targetHeight !== undefined)
      reasonParts.push(`target=${preferences.targetHeight}`)
    if (requireSibling.length > 0) reasonParts.push(`bypassed=${requireSibling.join('|')}`)

    const bound = this.boundSlotFor(input.deviceId, winner.camStreamId)
    if (bound !== null) reasonParts.push(`profile=${bound.profile}`)

    return {
      camStreamId: winner.camStreamId,
      codec: winner.codec,
      resolution: winner.resolution,
      transcodes: ranked.transcodes,
      reason: reasonParts.join(' '),
      // What a consumer needs to ACT, not just to identify. An exporter may
      // never open the camera's own url, so a picker that answers with a
      // camStreamId alone has named something nobody can dial — and each
      // consumer then translates it back itself. Alexa wrote
      // `profileForCamStream` for exactly that.
      ...(bound === null
        ? {}
        : {
            profile: bound.profile,
            brokerId: bound.brokerId,
            ...(bound.url === undefined ? {} : { url: bound.url }),
          }),
      // The publisher's declared rate, carried WITH its provenance: a measured
      // rate is a different statement and the two must not be confused. A
      // HomeKit accessory advertised 720p at 24 fps while the slot serving it
      // ran at 9, and the controller rendered nothing at all.
      ...(winner.fps === undefined ? {} : { fps: winner.fps, fpsSource: 'published' as const }),
    }
  }

  /**
   * The profile slot serving `camStreamId`, with the url to dial it, or null
   * when the broker has bound no slot to it.
   *
   * Both reads are local to the manager — no round trip is added to answer
   * what every consumer was fetching for itself.
   */
  private boundSlotFor(
    deviceId: number,
    camStreamId: string,
  ): { profile: CamProfile; brokerId: string; url?: string } | null {
    const slot = this.manager
      .getProfileSlotsForDevice(deviceId)
      .find((s) => s.sourceCamStreamId === camStreamId)
    if (slot === undefined) return null
    const entry = this.manager
      .getProfileRtspEntriesForDevice(deviceId)
      .find((e) => e.profile === slot.profile)
    return {
      profile: slot.profile,
      brokerId: slot.brokerId,
      ...(entry?.url === undefined ? {} : { url: entry.url }),
    }
  }
}

/**
 * Device-scoped WebRTC session facade.
 *
 * Implements `webrtcSessionCapability`. Resolves `{deviceId, profile}` to
 * a broker-integrated WebRTC session — no external webrtc addon needed.
 * The `BrokerWebrtcServer` subscribes directly to `IStreamBroker.onEncodedData()`
 * so frames flow Camera → Broker → RTP → WebRTC with zero re-encoding.
 */
export { BrokerWebrtcServer } from './webrtc/broker-webrtc-server.js'
import type { BrokerWebrtcServer, DownlinkProbeOutcome } from './webrtc/broker-webrtc-server.js'

export class WebrtcSessionProvider {
  constructor(
    private readonly webrtcServer: BrokerWebrtcServer,
    private readonly manager: StreamBrokerManager,
  ) {}

  private static readonly PROFILE_LABELS: Record<CamProfile, string> = {
    high: 'High',
    mid: 'Mid',
    low: 'Low',
  }

  /**
   * Per-device session debug flag passed to `BrokerWebrtcServer` (which
   * forwards it into `AdaptiveSession.debug`). True when EITHER the
   * "Streaming debug logs" toggle (`streamingDebug`) OR the dedicated
   * "Advanced WebRTC debug logging" toggle (`webrtcDebug`) is on for the
   * device. The latter is the operator switch that, when ON, turns on the
   * full per-step WebRTC lifecycle logging in `session.ts` for every
   * session created for this device. Read once at session creation so the
   * next session for a device picks up a freshly-toggled flag.
   */
  private resolveSessionDebug(deviceId: number): boolean {
    const streamingDebug =
      typeof this.manager.isStreamingDebug === 'function'
        ? this.manager.isStreamingDebug(deviceId)
        : false
    const webrtcDebug =
      typeof this.manager.isWebrtcDebug === 'function'
        ? this.manager.isWebrtcDebug(deviceId)
        : false
    return streamingDebug || webrtcDebug
  }

  /**
   * Resolve a structured `WebrtcStreamTarget` to the brokerId the
   * WebRTC server understands. `'adaptive'` yields the magic
   * `${deviceId}/adaptive` sentinel that triggers `selectBestBroker`
   * server-side; the other two kinds resolve to the canonical
   * cam-stream-keyed brokerId.
   */
  private resolveTargetToStreamId(deviceId: number, target: WebrtcStreamTarget): string {
    switch (target.kind) {
      case 'adaptive':
        return `${deviceId}/adaptive`
      case 'profile': {
        const slots = this.manager.getProfileSlotsForDevice(deviceId)
        const slot = slots.find((s) => s.profile === target.profile)
        if (!slot?.sourceCamStreamId) {
          throw new Error(
            `webrtc-session: profile "${target.profile}" has no source assigned for device ${deviceId}`,
          )
        }
        return makeSourceBrokerId(deviceId, slot.sourceCamStreamId)
      }
      case 'cam-stream':
        return makeSourceBrokerId(deviceId, target.camStreamId)
    }
  }

  /**
   * Resolve a `WebrtcStreamTarget` to its concrete camStreamId, or
   * `undefined` for adaptive (no single cam stream is pinned).
   */
  private resolveCamStreamId(deviceId: number, target: WebrtcStreamTarget): string | undefined {
    switch (target.kind) {
      case 'adaptive':
        return undefined
      case 'cam-stream':
        return target.camStreamId
      case 'profile': {
        const slots = this.manager.getProfileSlotsForDevice(deviceId)
        return slots.find((s) => s.profile === target.profile)?.sourceCamStreamId ?? undefined
      }
    }
  }

  /**
   * Resolve the `EncodeProfile` to use for a session.
   *
   *   1. The hardcoded WebRTC fallback profile applies, smart-adapted to
   *      the source's probed resolution so a 4K H.265 camera served to
   *      a no-HW-HEVC browser stays 4K H.264 instead of dropping to
   *      the baked 1280×720.
   *   2. Adaptive targets have no concrete camStreamId and always fall
   *      back to the raw fallback profile.
   */
  private resolveTranscodeProfile(
    deviceId: number,
    camStreamId: string | undefined,
  ): EncodeProfile {
    if (camStreamId === undefined) return WEBRTC_FALLBACK_PROFILE
    const probedSource = this.manager.getCameraStreamProbedParams(deviceId, camStreamId)
    return withSourceResolution(WEBRTC_FALLBACK_PROFILE, probedSource)
  }

  /**
   * Ensure a broker is registered for `brokerId` before delegating to the
   * WebRTC server (Slice 3 Task 3 — cross-node ingest wiring). Defers to
   * `StreamBrokerManager.ensureBrokerForWebrtcSession`, guarded the same way
   * `resolveSessionDebug` guards `manager.isStreamingDebug`/`isWebrtcDebug` —
   * older/test manager doubles that don't implement the hook simply skip it,
   * leaving today's local-only resolution completely unchanged.
   */
  private async ensureBrokerAvailable(
    deviceId: number,
    brokerId: string,
    camStreamId: string | undefined,
  ): Promise<void> {
    if (typeof this.manager.ensureBrokerForWebrtcSession !== 'function') return
    await this.manager.ensureBrokerForWebrtcSession(deviceId, brokerId, camStreamId)
    // Wake-on-play (D173). Everything above resolves a broker that EXISTS. A
    // sleeping battery camera has none — its catalog is served from the
    // durable slice so the cam-stream is known, but nothing has dialled it —
    // and `BrokerWebrtcServer` would answer the operator's play button with
    // "No broker for stream", which for a healthy camera one wake away from
    // streaming is simply false.
    //
    // Guarded like its sibling above: a manager double without the method is
    // a no-op, so every existing test and the whole mains-camera path stay
    // byte-identical.
    if (typeof this.manager.wakeBatteryDeviceOnPlay !== 'function') return
    await this.manager.wakeBatteryDeviceOnPlay(deviceId, brokerId, camStreamId)
  }

  /**
   * Best-effort cleanup for the remote-encoded adapter `ensureBrokerAvailable`
   * may have just registered, run when the `BrokerWebrtcServer` delegate that
   * follows it throws. Without this, a delegate failure AFTER a successful
   * remote-adapter registration (session-construction/offer error, server
   * stopping mid-request, …) leaks the adapter forever — its only other
   * teardown path is the inner broker's `onDemandChange(false)` edge, which
   * never fires because no session ever reached the `true` (demand-active)
   * edge. Guarded the same way `ensureBrokerAvailable` guards the manager
   * hook itself — older/test manager doubles without the method are a no-op,
   * so the owner==self / local-broker happy path is byte-identical.
   */
  private async disposeRemoteBrokerAdapterOnDelegateFailure(brokerId: string): Promise<void> {
    if (typeof this.manager.disposeRemoteBrokerAdapterIfPresent !== 'function') return
    await this.manager.disposeRemoteBrokerAdapterIfPresent(brokerId).catch(() => {
      // Best-effort — `disposeRemoteBrokerAdapterIfPresent` already logs
      // dispose failures internally; never let cleanup mask the original
      // delegate error the caller is about to re-throw.
    })
  }

  async listStreams(input: { deviceId: number }): Promise<readonly WebrtcStreamChoice[]> {
    const { deviceId } = input
    const slots = this.manager.getProfileSlotsForDevice(deviceId)
    const assignedSlots = slots.filter((s) => s.sourceCamStreamId !== null)
    const camStreams = this.manager.getCameraStreamsForDevice(deviceId)
    const camStreamById = new Map<string, CameraStream>()
    for (const c of camStreams) camStreamById.set(c.camStreamId, c)

    const choices: WebrtcStreamChoice[] = []

    if (assignedSlots.length > 0) {
      choices.push({
        id: 'adaptive',
        label: 'Adaptive',
        target: { kind: 'adaptive' },
        codec: null,
        resolution: null,
        status: null,
        inputFps: null,
        bitrateKbps: null,
      })
    }

    // Profile-tier choices: pin a session to high / mid / low. Source
    // can change as the operator reassigns the slot — the session
    // follows.
    for (const slot of assignedSlots) {
      const profile = slot.profile
      const camStreamId = slot.sourceCamStreamId
      if (!camStreamId) continue
      const broker = await this.manager.getBroker({
        brokerId: makeSourceBrokerId(deviceId, camStreamId),
      })
      const stats = broker?.getStats()
      const cam = camStreamById.get(camStreamId)
      choices.push({
        id: `profile:${profile}`,
        label: WebrtcSessionProvider.PROFILE_LABELS[profile] ?? profile,
        target: { kind: 'profile', profile },
        codec: stats?.codec ?? cam?.codec ?? slot.codec ?? null,
        resolution: cam?.resolution ?? slot.resolution ?? null,
        status: stats?.status ?? null,
        inputFps: stats?.inputFps ?? null,
        bitrateKbps: stats?.bitrateKbps ?? null,
      })
    }

    // Cam-stream-direct choices: enumerate EVERY published camStream.
    // Each published stream has a live broker (broker lifecycle is 1:1
    // with `publishCameraStream` / `retractCameraStream`).
    for (const cam of camStreams) {
      const camStreamId = cam.camStreamId
      const broker = await this.manager.getBroker({
        brokerId: makeSourceBrokerId(deviceId, camStreamId),
      })
      const stats = broker?.getStats()
      // Derived streams carry a synthetic `derived:<name>` id — surface a
      // human "Derived · <name>" label (with resolution) so the operator can
      // pick a transcoded derived from the player's stream selector and tell
      // it apart from the physical source streams.
      const isDerived = camStreamId.startsWith('derived:')
      const derivedName = isDerived ? camStreamId.slice('derived:'.length) : camStreamId
      const res = cam.resolution ? ` (${cam.resolution.width}×${cam.resolution.height})` : ''
      const label = cam.label ?? (isDerived ? `Derived · ${derivedName}${res}` : camStreamId)
      choices.push({
        id: `stream:${camStreamId}`,
        label,
        target: { kind: 'cam-stream', camStreamId },
        codec: stats?.codec ?? cam.codec ?? null,
        resolution: cam.resolution ?? null,
        status: stats?.status ?? null,
        inputFps: stats?.inputFps ?? null,
        bitrateKbps: stats?.bitrateKbps ?? null,
      })
    }
    return choices
  }

  async createSession(input: {
    deviceId: number
    target: WebrtcStreamTarget
    hints?: WebrtcClientHints
    /**
     * SERVER-INJECTED relay-only flag (set by the hub when the viewer's
     * IP is non-LAN). Forces TURN-relay-only ICE for this session so a
     * CGNAT/4G client gets a clean relay↔relay media path. LAN viewers
     * leave this absent and keep the direct host/srflx path. See the
     * cap definition (`webrtc-session.cap.ts`) for the rationale.
     */
    relayOnly?: boolean
    /**
     * Subscriber attribution surfaced in the stream-broker widget's
     * client list. Hub-router sets `remoteAddr` from the tRPC request
     * context; callers (Alexa addon, browser hooks) provide `kind`,
     * `label`, `userId`, and `sessionId` when known.
     */
    consumerAttribution?: BrokerConsumerAttribution
  }): Promise<{ sessionId: string; sdpOffer: string }> {
    const streamId = this.resolveTargetToStreamId(input.deviceId, input.target)
    const camStreamId = this.resolveCamStreamId(input.deviceId, input.target)
    await this.ensureBrokerAvailable(input.deviceId, streamId, camStreamId)
    const streamingDebug = this.resolveSessionDebug(input.deviceId)
    const transcodeProfile = this.resolveTranscodeProfile(input.deviceId, camStreamId)
    try {
      return await this.webrtcServer.createSession(streamId, input.hints, {
        streamingDebug,
        relayOnly: input.relayOnly === true,
        transcodeProfile,
        ...(input.consumerAttribution !== undefined
          ? { consumerAttribution: input.consumerAttribution }
          : {}),
      })
    } catch (err) {
      await this.disposeRemoteBrokerAdapterOnDelegateFailure(streamId)
      throw err
    }
  }

  async handleOffer(input: {
    deviceId: number
    target?: WebrtcStreamTarget
    sdpOffer: string
    sessionId?: string
    /**
     * Relay-only flag. A cloud peer (Alexa's RTCSessionController) sets
     * this `true` — it's only reachable via TURN, never our host/srflx.
     * A browser doing client-offer passthrough leaves it absent/false so
     * a direct LAN/Tailscale host pair carries full native quality. See
     * the cap definition (`webrtc-session.cap.ts`) for the rationale.
     */
    relayOnly?: boolean
    /**
     * Non-trickle flag. A peer that doesn't support trickle ICE (Alexa's
     * RTCSessionController) sets this `true` so the answer SDP carries the
     * server's gathered candidates instead of trickling them separately. A
     * browser leaves it absent/false and polls `getIceCandidates`. See the
     * cap definition (`webrtc-session.cap.ts`) for the rationale.
     */
    nonTrickle?: boolean
    /**
     * Disable-TURN flag. Strips TURN servers from the per-session iceConfig
     * so the answer carries ONLY host + srflx candidates. See the cap
     * definition (`webrtc-session.cap.ts`) for the rationale.
     */
    disableTurn?: boolean
    /**
     * Disable-IPv6 flag. Suppresses IPv6 host candidates from werift
     * gathering and from `additionalHostAddresses`. Set `true` by peers
     * that document IPv4-only ICE (Alexa). See the cap definition.
     */
    disableIpv6?: boolean
    /** Subscriber attribution. See `createSession` for the contract. */
    consumerAttribution?: BrokerConsumerAttribution
    /**
     * Client stream hints (viewport, downlink) — same contract as
     * `createSession`. Client-offer viewers (the RN viewer) negotiate via
     * this method, so the adaptive ladder needs their display size here too.
     */
    hints?: WebrtcClientHints
    /** Relay the peer's audio to this device's intercom (D771). Trusted
     *  callers only — the hub strips it from request-bound calls. */
    talkback?: boolean
  }): Promise<{ sessionId: string; sdpAnswer: string }> {
    // Default to adaptive: client-offer callers (Alexa, WHEP) don't
    // know about our profile slot model; they just want "give me a
    // working video session for this device". The same adaptive
    // selection logic the UI uses applies cleanly.
    const target: WebrtcStreamTarget = input.target ?? { kind: 'adaptive' }
    const streamId = this.resolveTargetToStreamId(input.deviceId, target)
    const camStreamId = this.resolveCamStreamId(input.deviceId, target)
    await this.ensureBrokerAvailable(input.deviceId, streamId, camStreamId)
    const streamingDebug = this.resolveSessionDebug(input.deviceId)
    const transcodeProfile = this.resolveTranscodeProfile(input.deviceId, camStreamId)
    try {
      return await this.webrtcServer.handleOffer(streamId, input.sdpOffer, input.hints, {
        streamingDebug,
        sessionId: input.sessionId,
        relayOnly: input.relayOnly === true,
        nonTrickle: input.nonTrickle === true,
        disableTurn: input.disableTurn === true,
        disableIpv6: input.disableIpv6 === true,
        talkback: input.talkback === true,
        transcodeProfile,
        ...(input.consumerAttribution !== undefined
          ? { consumerAttribution: input.consumerAttribution }
          : {}),
      })
    } catch (err) {
      await this.disposeRemoteBrokerAdapterOnDelegateFailure(streamId)
      throw err
    }
  }

  async handleAnswer(input: {
    deviceId: number
    sessionId: string
    sdpAnswer: string
  }): Promise<void> {
    await this.webrtcServer.handleAnswer(input.sessionId, input.sdpAnswer)
  }

  async addIceCandidate(input: {
    deviceId: number
    sessionId: string
    candidate: string
    sdpMid?: string | null
    sdpMLineIndex?: number | null
  }): Promise<void> {
    await this.webrtcServer.addIceCandidate(input.sessionId, {
      candidate: input.candidate,
      sdpMid: input.sdpMid ?? null,
      sdpMLineIndex: input.sdpMLineIndex ?? null,
    })
  }

  async getIceCandidates(input: { deviceId: number; sessionId: string }): Promise<{
    candidates: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }[]
    done: boolean
  }> {
    return this.webrtcServer.getIceCandidates(input.sessionId)
  }

  async closeSession(input: { deviceId: number; sessionId: string }): Promise<void> {
    await this.webrtcServer.closeSession(input.sessionId)
  }

  async hasAdaptiveBitrate(_input: { deviceId: number; profile: CamProfile }): Promise<boolean> {
    // Broker-direct mode: no adaptive bitrate switching (single source per profile).
    // The broker serves the camera's native stream at its native bitrate.
    return false
  }

  async getSessionState(input: { deviceId: number; sessionId: string }): Promise<{
    pendingRenegotiation: { target: WebrtcStreamTarget; epoch: number } | null
    alive: boolean
  }> {
    return this.webrtcServer.getSessionRenegotiationState(input.sessionId)
  }

  /** The viewer's downlink probe for one session (D733) — see the cap's docblock. */
  async applyDownlinkProbe(input: {
    deviceId: number
    sessionId: string
    downlinkMbps: number
  }): Promise<DownlinkProbeOutcome> {
    return this.webrtcServer.applyDownlinkProbe(input.sessionId, input.downlinkMbps)
  }

  /**
   * The SERVER half of the stream-debug overlay. Thin facade — the gathering
   * lives in the WebRTC server and the shaping in the pure
   * `projectSessionDebug`. `deviceId` is not used to look the session up
   * (session ids are already unique); it is part of the device-scoped cap's
   * signature and identifies the camera for the route.
   */
  async getSessionDebug(input: {
    deviceId: number
    sessionId: string
  }): Promise<WebrtcSessionDebug> {
    return this.webrtcServer.getSessionDebug(input.sessionId, Date.now())
  }
}
