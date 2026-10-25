/**
 * Builders for tape records, shared by every tracking-bench spec. Plain data —
 * a spec that needs a different shape overrides fields rather than growing a
 * second builder.
 */
import { DETECTION_SENSITIVITY_DEFAULTS } from '../../detection-sensitivity-settings.js'
import { TRACKING_DEFAULTS } from '../../tracking-settings.js'
import { decodeTapeText, type Tape } from '../tape-codec.js'
import {
  TAPE_FORMAT,
  TAPE_RECORDER_ID,
  TAPE_VERSION,
  type TapeEnd,
  type TapeFrame,
  type TapeHeader,
  type TapeProcessorInputs,
  type TapeScene,
} from '../tape-schema.js'

export function sampleInputs(): TapeProcessorInputs {
  return { sensitivity: { ...DETECTION_SENSITIVITY_DEFAULTS }, tracking: { ...TRACKING_DEFAULTS } }
}

export function sampleScene(): TapeScene {
  return { zones: [], rules: [], zoneMembershipMinOverlap: 0, lowScoreFloor: 0.35 }
}

export function sampleHeader(over: Partial<TapeHeader> = {}): TapeHeader {
  return {
    kind: 'header',
    format: TAPE_FORMAT,
    version: TAPE_VERSION,
    tapeId: 'tape-0001',
    deviceId: 101,
    lighting: 'day',
    recorder: TAPE_RECORDER_ID,
    planes: { pipeline: sampleInputs() },
    scene: sampleScene(),
    stationaryEntries: [],
    ...over,
  }
}

export function sampleFrame(t: number, over: Partial<TapeFrame> = {}): TapeFrame {
  return {
    kind: 'frame',
    t,
    plane: 'pipeline',
    w: 1280,
    h: 720,
    dets: [
      {
        id: `d-${t}`,
        k: 'first-level',
        cls: 'person',
        s: 0.8,
        b: [100, 100, 50, 120],
        src: 'frame',
      },
    ],
    disc: [],
    inj: [],
    live: [{ trk: 'trk-a', det: `d-${t}`, m: true, st: 'moving' }],
    ...over,
  }
}

export function sampleEnd(over: Partial<TapeEnd> = {}): TapeEnd {
  return {
    kind: 'end',
    durationMs: 1_000,
    frames: 2,
    skips: 0,
    gaps: 0,
    reason: 'segment-end',
    ...over,
  }
}

/** One first-level detection of a {@link tapeOf} frame. */
export interface TapeOfDetection {
  readonly id: string
  readonly cls: string
  readonly s: number
  readonly b: readonly [number, number, number, number]
}

/** One frame of a {@link tapeOf} tape. */
export interface TapeOfFrame {
  readonly t: number
  readonly dets: readonly TapeOfDetection[]
}

/**
 * A tape of plain first-level frames (`pipeline` plane, 1920×1080, empty
 * `disc`/`inj`/`live`) after `sampleHeader()`, with no `end` record. Encoded
 * as JSON lines and read back through `decodeTapeText`, so the strict schema
 * validates it — never a hand-typed literal against `TAPE_VERSION`.
 */
export function tapeOf(frames: readonly TapeOfFrame[]): Tape {
  const lines = [
    JSON.stringify(sampleHeader()),
    ...frames.map((f) =>
      JSON.stringify({
        kind: 'frame',
        t: f.t,
        plane: 'pipeline',
        w: 1920,
        h: 1080,
        dets: f.dets.map((d) => ({
          id: d.id,
          k: 'first-level',
          cls: d.cls,
          s: d.s,
          b: [...d.b],
          src: 'frame',
        })),
        disc: [],
        inj: [],
        live: [],
      }),
    ),
  ]
  return decodeTapeText(lines.join('\n'))
}
