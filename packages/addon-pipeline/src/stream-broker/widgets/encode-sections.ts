/**
 * How the derived-stream editor maps ONE persisted `EncodeProfile` to its
 * independent sections, in both directions. The sections combine freely: each
 * is switched on separately and owns only its own fields.
 *
 * - `resize`: `video.width` (the height follows the source ratio). A profile
 *   stored by the old editor carries `video.height` only; it also switches the
 *   section on, and `resolution-ladder.ts` reads it as the matching width.
 * - `codec`: `video.codec` of `h264` / `h265` (the section is OFF when the
 *   codec is `source` or `copy`: the stream keeps the source codec).
 * - `audio`: an audio object other than `copy` (`passthrough` is the OFF state).
 * - `fps`: `video.fps`.
 *
 * Everything else — bitrate, keyframe interval, profile, preset, the
 * audio bitrate, the raw args — has no section and lives under Expert; a
 * section edit spreads the profile it was given, so those fields survive.
 *
 * A section that is off contributes nothing. When no section drives a
 * re-encode, the video codec falls back to `copy`, so a profile with every
 * section off is the passthrough profile.
 *
 * Adding a section (crop, #611) means: an id here, its `sectionsOf` clause, a
 * `with…` setter, and one card in the editor.
 */
import {
  type AudioEncode,
  type EncodeProfile,
  type VideoEncode,
  VideoEncodeSchema,
} from '@camstack/types'

export type SectionId = 'resize' | 'codec' | 'audio' | 'fps'

export const ENCODE_SECTIONS: readonly SectionId[] = ['resize', 'codec', 'audio', 'fps']

export type SectionState = Readonly<Record<SectionId, boolean>>

/** What the codec section offers. Keeping the source codec is the section being OFF. */
export type VideoCodecChoice = 'h264' | 'h265'

/** What the audio section offers on top of the passthrough OFF state. */
export type AudioChoice = 'aac' | 'opus' | 'none'

export const PASSTHROUGH_PROFILE: EncodeProfile = {
  video: { codec: 'copy' },
  audio: 'passthrough',
}

export const NO_SECTIONS: SectionState = {
  resize: false,
  codec: false,
  audio: false,
  fps: false,
}

/** The sections a stored profile switches on — exactly those its fields imply. */
export function sectionsOf(profile: EncodeProfile | undefined): SectionState {
  if (profile === undefined) return NO_SECTIONS
  const { video, audio } = profile
  return {
    resize: video.width !== undefined || video.height !== undefined,
    codec: video.codec === 'h264' || video.codec === 'h265',
    fps: video.fps !== undefined,
    audio: audio !== 'passthrough' && audio.codec !== 'copy',
  }
}

/** The codec select's value for a stored profile (H.264 while the section has no codec yet). */
export function videoCodecChoiceOf(profile: EncodeProfile | undefined): VideoCodecChoice {
  return profile?.video.codec === 'h265' ? 'h265' : 'h264'
}

/** The audio select's value: the stored codec, `aac` when nothing is stored. */
export function audioCodecOf(profile: EncodeProfile | undefined): string {
  const audio = profile?.audio
  return audio === undefined || audio === 'passthrough' ? 'aac' : audio.codec
}

/** Video keys that decide the picture or the cadence, so they force a re-encode. */
const RE_ENCODE_DRIVERS: ReadonlySet<string> = new Set(['height', 'width', 'fps'])

function drivesReEncode(video: VideoEncode): boolean {
  return Object.keys(video).some((key) => RE_ENCODE_DRIVERS.has(key))
}

function hasTuning(video: VideoEncode): boolean {
  return Object.keys(video).some((key) => key !== 'codec' && !RE_ENCODE_DRIVERS.has(key))
}

/**
 * After a section edit: a codec that is neither H.264 nor H.265 follows what
 * the profile asks for — `source` while something drives a re-encode, `copy`
 * once nothing does and no tuning field is left behind.
 */
function settleVideoCodec(profile: EncodeProfile): EncodeProfile {
  const { video } = profile
  if (video.codec === 'h264' || video.codec === 'h265') return profile
  if (drivesReEncode(video)) return { ...profile, video: { ...video, codec: 'source' } }
  if (hasTuning(video)) return profile
  return { ...profile, video: { ...video, codec: 'copy' } }
}

/** The video fields an editor control sets or clears one at a time. */
export type VideoFieldKey =
  | 'height'
  | 'width'
  | 'fps'
  | 'bitrateKbps'
  | 'gopFrames'
  | 'preset'
  | 'profile'

/** Set (or, with `undefined`, remove) one video field; the codec settles afterwards. */
export function withVideoField<K extends VideoFieldKey>(
  profile: EncodeProfile | undefined,
  key: K,
  value: VideoEncode[K] | undefined,
): EncodeProfile {
  const base = profile ?? PASSTHROUGH_PROFILE
  if (value !== undefined) {
    return settleVideoCodec({ ...base, video: { ...base.video, [key]: value } })
  }
  const rest = VideoEncodeSchema.parse(
    Object.fromEntries(Object.entries(base.video).filter(([field]) => field !== key)),
  )
  return settleVideoCodec({ ...base, video: rest })
}

/**
 * Resize: set (or, with `undefined`, clear) the output width. The height is
 * always cleared: it follows the source aspect ratio, and a height left over
 * from the old editor would contradict the new width.
 */
export function withWidth(
  profile: EncodeProfile | undefined,
  width: number | undefined,
): EncodeProfile {
  return withVideoField(withVideoField(profile, 'height', undefined), 'width', width)
}

/** Frame rate: set (or clear) the output fps. */
export function withFps(
  profile: EncodeProfile | undefined,
  fps: number | undefined,
): EncodeProfile {
  return withVideoField(profile, 'fps', fps)
}

/**
 * Video codec: `null` switches the section off, which keeps the source codec
 * — a re-encode in the source codec, or a copy when nothing else asks for one.
 */
export function withVideoCodec(
  profile: EncodeProfile | undefined,
  codec: VideoCodecChoice | null,
): EncodeProfile {
  const base = profile ?? PASSTHROUGH_PROFILE
  return settleVideoCodec({
    ...base,
    video: { ...base.video, codec: codec === null ? 'source' : codec },
  })
}

/** Audio: `null` switches the section off (passthrough); the rest of an audio object is kept. */
export function withAudioCodec(
  profile: EncodeProfile | undefined,
  codec: 'aac' | 'opus' | 'pcmu' | 'pcma' | 'none' | null,
): EncodeProfile {
  const base = profile ?? PASSTHROUGH_PROFILE
  if (codec === null) return { ...base, audio: 'passthrough' }
  const audio: AudioEncode = typeof base.audio === 'object' ? { ...base.audio, codec } : { codec }
  return { ...base, audio }
}

/** Parse a select value into the codec section's choices; `undefined` for anything else. */
export function parseVideoCodecChoice(value: string): VideoCodecChoice | undefined {
  return value === 'h264' || value === 'h265' ? value : undefined
}

/** Parse a select value into the audio codecs the editor writes. */
export function parseAudioCodec(
  value: string,
): 'aac' | 'opus' | 'pcmu' | 'pcma' | 'none' | undefined {
  return value === 'aac' ||
    value === 'opus' ||
    value === 'pcmu' ||
    value === 'pcma' ||
    value === 'none'
    ? value
    : undefined
}

/** True when the profile is the plain passthrough: nothing to encode, nothing to add. */
export function isPassthrough(profile: EncodeProfile): boolean {
  const { video, audio } = profile
  return (
    video.codec === 'copy' &&
    Object.keys(video).length === 1 &&
    audio === 'passthrough' &&
    (profile.inputArgs?.length ?? 0) === 0 &&
    (profile.outputArgs?.length ?? 0) === 0
  )
}

/**
 * What an edit saves. Passthrough is no profile: a stream back at passthrough
 * saves `undefined` (the writer clears the stored one), never an explicit copy profile.
 */
export function profileToSave(next: EncodeProfile): EncodeProfile | undefined {
  return isPassthrough(next) ? undefined : next
}

/**
 * How many things differ between the stored profile and the edited one, for
 * the save bar: each video field, the audio, and each raw-args list count once.
 */
export function changedFieldCount(
  stored: EncodeProfile | undefined,
  edited: EncodeProfile | undefined,
): number {
  const a = stored ?? PASSTHROUGH_PROFILE
  const b = edited ?? PASSTHROUGH_PROFILE
  const videoKeys = new Set([...Object.keys(a.video), ...Object.keys(b.video)])
  const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y)
  let count = 0
  for (const key of videoKeys) {
    if (!same(Reflect.get(a.video, key), Reflect.get(b.video, key))) count += 1
  }
  if (!same(a.audio, b.audio)) count += 1
  if (!same(a.inputArgs ?? [], b.inputArgs ?? [])) count += 1
  if (!same(a.outputArgs ?? [], b.outputArgs ?? [])) count += 1
  return count
}
