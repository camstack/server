/**
 * Client-side wire codec for the `camstack-control` RTCDataChannel (R9).
 *
 * Mirrors the broker's `control-protocol.ts`
 * (packages/addon-pipeline/src/stream-broker/recorded/control-protocol.ts):
 * client→server commands drive the per-viewer `TimelineSession` /
 * `RecordedFeeder` (frame-push recorded playback on the SAME WebRTC session
 * as live video); server→client messages report playback state + a ~1 Hz
 * position. Shapes are re-declared here (not imported) because ui-library
 * cannot depend on an addon package — the embed SPA does the same.
 *
 * Parsing is defensive: a malformed frame returns `null`, never throws, so a
 * bad datachannel message can't take down the player.
 */

// ── Client → server commands ────────────────────────────────────────────────

export type RecordedControlCommand =
  | {
      readonly t: 'playRecorded'
      readonly deviceId: number
      readonly epoch: number
      readonly profile: string
    }
  | { readonly t: 'seek'; readonly epoch: number }
  | { readonly t: 'scrubCommit'; readonly epoch: number }
  | { readonly t: 'setRate'; readonly rate: 0 | 1 }
  | { readonly t: 'goLive' }
  | { readonly t: 'setProfile'; readonly profile: string }

/** Serialize a command for `RTCDataChannel.send` (matches the server schema). */
export function serializeRecordedCommand(cmd: RecordedControlCommand): string {
  return JSON.stringify(cmd)
}

// ── Server → client messages ────────────────────────────────────────────────

/**
 * Playback mode reported by the server session. `live` = the shared live feed
 * owns the track; every other value describes the recorded feeder.
 */
export const RECORDED_PLAYBACK_MODES = [
  'live',
  'loading',
  'playing',
  'paused',
  'gap',
  'ended',
  'error',
] as const

export type RecordedPlaybackMode = (typeof RECORDED_PLAYBACK_MODES)[number]

function isRecordedPlaybackMode(value: unknown): value is RecordedPlaybackMode {
  return typeof value === 'string' && (RECORDED_PLAYBACK_MODES as readonly string[]).includes(value)
}

export type RecordedServedProfile = 'high' | 'mid' | 'low'

function isRecordedServedProfile(value: unknown): value is RecordedServedProfile {
  return value === 'high' || value === 'mid' || value === 'low'
}

export type RecordedServerMessage =
  | { readonly kind: 'state'; readonly state: RecordedPlaybackMode }
  | { readonly kind: 'position'; readonly epochMs: number }
  /** The tier actually playing, next to the one the client asked for. */
  | {
      readonly kind: 'servedProfile'
      readonly profile: RecordedServedProfile
      readonly requested: string
    }

/**
 * Parse a raw server→client control frame. Returns `null` on any malformed
 * payload (bad JSON, unknown discriminator, wrong field types).
 */
export function parseRecordedServerMessage(raw: string): RecordedServerMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj: Record<string, unknown> = { ...parsed }
  if (obj.t === 'state' && isRecordedPlaybackMode(obj.state)) {
    return { kind: 'state', state: obj.state }
  }
  if (obj.t === 'position' && typeof obj.epochMs === 'number') {
    return { kind: 'position', epochMs: obj.epochMs }
  }
  if (
    obj.t === 'servedProfile' &&
    isRecordedServedProfile(obj.profile) &&
    typeof obj.requested === 'string'
  ) {
    return { kind: 'servedProfile', profile: obj.profile, requested: obj.requested }
  }
  return null
}
