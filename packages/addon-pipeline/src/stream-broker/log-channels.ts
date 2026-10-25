/**
 * The diagnostic log CHANNELS `stream-broker` declares.
 *
 * Declared here because only this addon knows they exist: what "ICE", "RTP"
 * and "the WebRTC negotiation lifecycle" mean is knowledge of the broker, and
 * a central list somewhere else would rot the first time somebody adds a
 * fourth — invisibly, because nothing fails when a list is merely incomplete.
 *
 * The VALUE — armed or not, for which cameras, until when — is not here and
 * never will be. It lives in the one logging settings document on the `system`
 * cap. These are declarations: inert, no state.
 *
 * ## Why these three and not thirty
 *
 * They are the three the operator named. Declaring twenty in advance is the
 * same bet that produced five overlapping debug mechanisms in the first place;
 * the next channel gets declared the first time somebody needs it.
 *
 * ## What each one is honestly worth per camera
 *
 * `perDevice: true` is a promise with two halves — the gate is consulted with
 * the numeric device id, AND the lines it admits carry `tags: { deviceId }`.
 * Only the first half is under this file's control, so each declaration below
 * states which lines it governs and why the second half does or does not hold.
 */

import { declareLogChannel } from '@camstack/types'

/**
 * The WebRTC negotiation and media lifecycle for one camera: SDP offer/answer,
 * codec negotiation, DTLS state, the nominated pair, first RTP out.
 *
 * Consulted at the single funnel `StreamBrokerManager.isWebrtcDebug`, which
 * `resolveSessionDebug` (`device-scoped-providers.ts`) already feeds into every
 * `AdaptiveSession` created for the device — so arming this channel lights the
 * whole `session.ts` diagnostic set without a second gate anywhere.
 *
 * `perDevice: true` holds end to end: the session logger is built with
 * `withTags(deviceTags)` in `broker-webrtc-server.ts`, and `ScopedLogger`
 * merges bound tags into every line, so every one of those lines carries
 * `tags.deviceId` as the numeric id. `| json | deviceId="102"` works.
 *
 * Read at session CREATION, so it takes effect on the next session rather than
 * mid-call — the same property the per-camera `webrtcDebug` switch has always
 * had, and the reason arming this is not enough on its own to explain a call
 * already in progress.
 */

export const CH_WEBRTC = declareLogChannel({
  name: 'stream-broker.webrtc',
  description:
    'WebRTC negotiation and media lifecycle for a camera: SDP offer/answer, codec negotiation, DTLS state, the nominated ICE pair and the first RTP packet out. Takes effect on the NEXT session for that camera, not the one already running.',
  defaultLevel: 'info',
  perDevice: true,
})

/**
 * The broker's own RTP and parameter-set plumbing: subscribers attaching and
 * detaching from the RTP video fan-out, and the in-band SPS/PPS prepend that
 * fires when a keyframe arrives without them.
 *
 * `perDevice: FALSE`, and this is not an oversight — it is the corollary the
 * plan insists be made explicit. These lines put the device in `meta`, not in
 * `tags`, so `| json | deviceId="102"` does not select them. Declaring this
 * channel per-camera would be a lie the UI repeats: an operator would narrow
 * to one camera, see nothing, and conclude the code path was never taken.
 *
 * Making it true is a real, separate change — bind the broker's logger with
 * `withTags({ deviceId: this.numericDeviceId })` so all nine sites inherit the
 * tag — and it belongs to whoever needs the per-camera filter, not to the
 * commit that declares the channel.
 */
export const CH_RTP = declareLogChannel({
  name: 'stream-broker.rtp',
  description:
    'Broker-side RTP plumbing: video subscribers attaching and detaching, and the SPS/PPS prepend on a keyframe that arrived without in-band parameter sets. NOT filterable per camera — these lines carry the device in `meta`, not in `tags.deviceId`.',
  defaultLevel: 'info',
  perDevice: false,
})

/**
 * Every channel this addon declares, as a VALUE.
 *
 * `addon.ts` used to reach the declarations through a bare
 * `import './log-channels.js'` — an import with no binding, kept alive only by
 * a comment saying "never drop this as unused". On 2026-08-29 the shipped
 * bundle contained this module TWICE: inlined into `stream-broker/index.mjs`
 * and again in a shared chunk that same entry statically imports. Loading the
 * addon ran `declareLogChannel` twice, the duplicate was refused — correctly,
 * that guard is doing its job — and the whole stream-broker failed to load.
 * The hub had no broker and no live streams until it was rolled back.
 *
 * The duplication has NOT been reproduced since, from a clean dist or a dirty
 * one, so this is not offered as a proven fix: it removes the freedom the
 * bundler took. A value binding must resolve to one module instance; a
 * side-effect import need not. `scripts/check-log-channel-single-declaration.ts`
 * is the part that actually holds, because it reads the artefact.
 */
export const STREAM_BROKER_LOG_CHANNELS = [CH_WEBRTC, CH_RTP] as const
