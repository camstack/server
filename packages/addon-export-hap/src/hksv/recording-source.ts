/**
 * Which camstack profile slot HomeKit Secure Video records from, and whether it
 * may be recorded at all.
 *
 * ## The measurement this file encodes
 *
 * HKSV needs a **permanent** per-camera fMP4 child: the prebuffer only exists
 * because the muxer never stopped. §A4.2 of the assessment refused to schedule
 * that until someone measured it, against `docs/decisions/adr-0067.md`'s figure
 * of ~77 % of a core for a 4K→1080p transcode on a hub already at 70-95 %.
 *
 * Measured 2026-08-07 against camera 101's live restream, 45 s samples, the
 * exact argv `buildFmp4SinkArgs` emits ([D84](../../../../docs/decisions/adr-0084.md)):
 *
 * | branch | CPU (1 core = 100 %) | RSS |
 * | --- | --- | --- |
 * | `-c:v copy` 1280×720 + AAC | **0.7 %** | 30 MB |
 * | `-c:v copy` 3840×2160 + AAC | **2.8 %** | 77 MB |
 * | 4K→1080p `libx264 veryfast` + AAC | **89.9 %** | 577 MB |
 *
 * **128×.** So the rule is not a preference: a permanent prebuffer is affordable
 * on the COPY branch and on no other, and a camera that cannot be copied does
 * not advertise recording rather than quietly costing a core. HKSV takes H.264
 * only, so "can be copied" is exactly "the slot is H.264".
 *
 * ## Why not 4K
 *
 * The same measurement: one 8 s fragment is 255 KB at 720p and **6.35 MB** at
 * 4K, and the prebuffer holds fragments in RAM in the exporter's runner. A
 * fleet-wide 4K prebuffer is tens of MB of resident heap for context nobody
 * asked for, and iOS renders HKSV clips at 1080p regardless. The picker
 * therefore prefers the largest slot at or below 1080p and only reaches for a
 * bigger one if there is nothing else.
 */
import type { RtspEntryLike } from '@camstack/types'

/** The tallest frame the recording path will hold in its prebuffer. */
export const MAX_RECORDING_HEIGHT = 1080

/** HKSV takes H.264 only — AAC audio and H.264 video, no negotiation. */
const RECORDABLE_CODEC = 'h264'

export interface RecordingSource {
  readonly brokerId: string
  readonly profile: string
  /**
   * The prebuffer must RE-ENCODE this slot, because it is not H.264.
   *
   * Carried on the source rather than re-derived from the codec downstream:
   * this single boolean is the difference between a child costing 0.7-2.8 % of
   * a core and one costing most of a core, permanently, and a decision that
   * expensive is made once, in one place, by the picker that had the evidence.
   */
  readonly transcode: boolean
  /** The url WITH audio. The muted twin is used when iOS turns audio off. */
  readonly url: string
  readonly mutedUrl: string
  readonly width: number
  readonly height: number
}

/** Why a camera cannot be recorded. Reported, never swallowed. */
export type RecordingRefusal =
  /** No slot at all — the camera has no enabled RTSP profile. */
  | 'no-enabled-stream'
  /** Every enabled slot is H.265: a permanent transcode, refused (see above). */
  | 'no-h264-stream'
  /** A slot exists but declares no resolution, so nothing honest can be advertised. */
  | 'no-resolution'

/** What the caller is willing to pay. */
export interface RecordingSourceOptions {
  /**
   * The operator's per-camera transcode switch (`allowTranscode`).
   *
   * Absent means NO. The expensive branch is opt-in at every call site so that
   * forgetting the parameter refuses a camera rather than quietly spawning a
   * permanent encoder on it.
   */
  readonly allowTranscode?: boolean
}

export type RecordingSourceChoice =
  | { readonly ok: true; readonly source: RecordingSource }
  | { readonly ok: false; readonly refusal: RecordingRefusal }

/**
 * Pick the slot the recording child pulls.
 *
 * Deliberately NOT `pickPreferredRtspEntry`: that picker resolves the operator's
 * LIVE preference and, on `auto`, steers by the resolution iOS negotiated for a
 * live session — neither is a fact about recording, and on 101 it selects `mid`,
 * a 10 fps slot. Recording has one criterion, applied here and nowhere else:
 * the largest copyable frame that does not exceed {@link MAX_RECORDING_HEIGHT}.
 */
export function pickRecordingSource(
  entries: readonly RtspEntryLike[],
  options: RecordingSourceOptions = {},
): RecordingSourceChoice {
  const enabled = entries.filter((e) => e.enabled)
  if (enabled.length === 0) return { ok: false, refusal: 'no-enabled-stream' }

  const h264 = enabled.filter((e) => normaliseCodec(e.codec) === RECORDABLE_CODEC)
  // A copy always wins when one exists — an H.264 low beside an H.265 high is
  // not a reason to burn a core, whatever the switch says.
  const pool = h264.length > 0 ? h264 : options.allowTranscode === true ? enabled : []
  if (pool.length === 0) return { ok: false, refusal: 'no-h264-stream' }
  const transcode = h264.length === 0

  const sized = pool.filter(hasUsableResolution)
  if (sized.length === 0) return { ok: false, refusal: 'no-resolution' }

  // Largest at or below the ceiling; if every slot is above it, the smallest of
  // those — a 4K-only camera still records, it just costs the 6.35 MB fragment.
  // The same rule serves the transcode branch for a second reason: decode is
  // the expensive half of a re-encode and its cost scales with the SOURCE, so
  // reaching past a small slot would be paid twice.
  const withinCeiling = sized.filter((e) => height(e) <= MAX_RECORDING_HEIGHT)
  const within = withinCeiling.length > 0
  const candidates = within ? withinCeiling : sized
  const best = [...candidates].sort((a, b) =>
    within ? height(b) - height(a) : height(a) - height(b),
  )[0]
  if (best === undefined || best.resolution === undefined) {
    return { ok: false, refusal: 'no-resolution' }
  }

  return {
    ok: true,
    source: {
      brokerId: best.brokerId,
      profile: best.profile ?? best.brokerId,
      transcode,
      url: best.url,
      mutedUrl: best.mutedUrl,
      width: best.resolution.width,
      height: best.resolution.height,
    },
  }
}

/** A one-line reason for the log — silence about a withdrawn service reads as a bug. */
export function refusalReason(refusal: RecordingRefusal): string {
  switch (refusal) {
    case 'no-enabled-stream':
      return 'the camera has no enabled RTSP profile'
    case 'no-h264-stream':
      return 'every enabled profile is H.265 — HKSV takes H.264 only, and a permanent transcode costs 128x a copy'
    case 'no-resolution':
      return 'no enabled profile declares a resolution, so nothing honest could be advertised'
  }
}

function height(entry: RtspEntryLike): number {
  return entry.resolution?.height ?? 0
}

function hasUsableResolution(entry: RtspEntryLike): entry is RtspEntryLike & {
  resolution: { width: number; height: number }
} {
  const r = entry.resolution
  return r !== undefined && r.width > 0 && r.height > 0
}

/** Publishers spell H.265 four ways; the same normalisation the broker uses. */
function normaliseCodec(codec: string | undefined): string {
  return (codec ?? '').toLowerCase().replace(/[.\s-]/g, '')
}
