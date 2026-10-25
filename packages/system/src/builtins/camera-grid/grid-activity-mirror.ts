/**
 * What a grid says about ITSELF, kept from what its sources said.
 *
 * ## Why the grid answers at all
 *
 * A grid is a camera, and the viewer already knows how to light a camera: the
 * motion ring keys off `motion.on-motion-changed` filtered by `deviceId`, the
 * audio one off `pipeline.audio-inference-result`. So the grid does not need a
 * new channel, a new cap or a line of app code — it needs to answer those
 * questions about its own device id. The operator set both rules: motion is on
 * if AT LEAST ONE source has it, and the audio level is the LOUDEST of them.
 *
 * It is derived from the SOURCES' events and never from the composed picture.
 * Analysing the composite would be a second motion authority for cameras that
 * already have one, and a decode this addon does not pay today.
 *
 * ## The falling edge is the whole difficulty
 *
 * Bus events are telemetry and may be dropped (D8/D11). A lost `detected:
 * false` would leave a grid lit for ever, and the grid has no phase machine to
 * produce a falling edge of its own — a real camera's comes from the pipeline
 * runner, which a grid deliberately does not run.
 *
 * So a source's motion is remembered WITH ITS TIME and expires on its own. That
 * is D49's shape: in-memory state refreshed off the event path, never a gate
 * that re-reads something fallible in order to decide. A dropped clear costs a
 * ring that stays lit until the expiry instead of for ever, and a subject that
 * is genuinely still there keeps renewing it.
 *
 * The expiry is `MOTION_CLOSE_AFTER_MS`, imported and not re-spelled: it is the
 * system's one answer to "how long after the last push is a camera still
 * moving", and a second number here would be a second authority disagreeing
 * with the first on exactly the cameras that make up the grid.
 */
import { MOTION_CLOSE_AFTER_MS } from '@camstack/types'

/**
 * How long an audio reading counts as current.
 *
 * The analyzer emits one per window per camera, so a source that has gone quiet
 * simply stops arriving — there is no "silence" event to wait for. Without a
 * window the loudest reading of the day would be the grid's level for ever.
 * Chosen to span several analysis windows so an ordinary gap does not blink the
 * level away, and to be far shorter than a person notices a stale ring.
 */
const AUDIO_FRESH_MS = 5_000

interface SourceMotion {
  readonly detected: boolean
  readonly atMs: number
}

interface SourceAudio {
  readonly dbfs: number
  readonly atMs: number
}

/** The grid's own motion answer, in the shape the `motion` cap publishes. */
export interface GridMotionState {
  readonly detected: boolean
  /** Ms epoch of the most recent rising edge on ANY source (never a heartbeat). Null if never. */
  readonly lastDetectedAt: number | null
}

export class GridActivityMirror {
  private readonly motion = new Map<number, SourceMotion>()
  private readonly audio = new Map<number, SourceAudio>()
  private lastDetectedAt: number | null = null

  /**
   * One source's motion push. `detected: false` is as important as `true`.
   *
   * `lastDetectedAt` moves only on a source's RISING edge — the source was not
   * moving, or its last `true` had expired. A source's pushes include a
   * heartbeat (the bridge's sustain ticks, every `true` a camera re-sends while
   * a subject stays), and moving the stamp on each one made the grid's
   * `lastDetectedAt` "the last tick of any cell" while every camera's is its
   * last effective RISE (D696): the viewer's Motion order then ranked the grid
   * above the very cells it shows (2026-10-06).
   */
  noteMotion(sourceDeviceId: number, detected: boolean, atMs: number): void {
    const prev = this.motion.get(sourceDeviceId)
    const wasMoving =
      prev !== undefined && prev.detected && atMs - prev.atMs <= MOTION_CLOSE_AFTER_MS
    this.motion.set(sourceDeviceId, { detected, atMs })
    if (detected && !wasMoving) this.lastDetectedAt = Math.max(this.lastDetectedAt ?? 0, atMs)
  }

  /** One source's audio window. `dbfs` is the level, on the analyzer's scale. */
  noteAudio(sourceDeviceId: number, dbfs: number, atMs: number): void {
    this.audio.set(sourceDeviceId, { dbfs, atMs })
  }

  /**
   * Drop every source this grid no longer composes.
   *
   * A cell removed while its camera was moving would otherwise hold the grid
   * lit until the expiry, for a picture the source is not even in.
   */
  keepOnly(sourceDeviceIds: readonly number[]): void {
    const keep = new Set(sourceDeviceIds)
    // A snapshot of the keys, because both loops delete from the map they walk.
    const motionIds = Array.from(this.motion.keys())
    const audioIds = Array.from(this.audio.keys())
    for (const id of motionIds) if (!keep.has(id)) this.motion.delete(id)
    for (const id of audioIds) if (!keep.has(id)) this.audio.delete(id)
  }

  /** At least one source moving, as of `nowMs`. */
  motionAt(nowMs: number): GridMotionState {
    let detected = false
    for (const state of this.motion.values()) {
      if (!state.detected) continue
      if (nowMs - state.atMs > MOTION_CLOSE_AFTER_MS) continue
      detected = true
      break
    }
    return { detected, lastDetectedAt: this.lastDetectedAt }
  }

  /**
   * The loudest CURRENT reading, or `null` when nothing fresh has been heard.
   *
   * Null and not `-Infinity`: "nobody has reported a level" is a different
   * answer from "it is silent", and a number here would have the viewer draw a
   * level for a grid whose sources are not being analysed at all.
   */
  loudestAt(nowMs: number): number | null {
    let loudest: number | null = null
    for (const state of this.audio.values()) {
      if (nowMs - state.atMs > AUDIO_FRESH_MS) continue
      if (loudest === null || state.dbfs > loudest) loudest = state.dbfs
    }
    return loudest
  }
}
