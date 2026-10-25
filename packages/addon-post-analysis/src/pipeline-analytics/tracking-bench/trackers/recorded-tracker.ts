/**
 * `recorded` — what the LIVE tracker did, as the tape recorded it (`live[]`),
 * re-emitted through the tracker interface. No production code runs. The CLI
 * scores it beside `CASE_TRACKER`: when the two disagree on a case, the replay
 * did not reproduce the live run — an input the recorder does not carry yet
 * (plan decision 15). The tape keeps no box for a coasting track, so only
 * bound outputs are re-emitted.
 */
import type { TapeControlRecord, TapeFrame, TapeHeader, TapePlane } from '../tape-schema.js'
import type {
  TapeFinalisation,
  TapeFinalOutput,
  TapeStepOutput,
  TapeTracker,
  TapeTrackOutput,
} from './tape-tracker.js'

const NO_OUTPUT: TapeStepOutput = { outputs: [], finalised: [] }

export class RecordedTracker implements TapeTracker {
  readonly name = 'recorded'
  private plane: TapePlane = 'pipeline'
  /** Recorded fusions not yet handed out by `step` / `finish`. */
  private pending: TapeFinalisation[] = []

  start(_header: TapeHeader, plane: TapePlane): void {
    this.plane = plane
    this.pending = []
  }

  // Re-emits what the LIVE tracker did: a recorded `fusion` (v2, D683) is the
  // live L2's decision, reported as one finalisation per member at the
  // record's `t`. Every other control record is ignored — `live[]` already
  // says what a recognizer verdict or a settings rebuild changed.
  control(record: TapeControlRecord): void {
    if (record.kind !== 'fusion' || record.plane !== this.plane) return
    for (const m of record.members) {
      this.pending.push({ provisionalId: m, finalId: record.survivor, t: record.t })
    }
  }

  private drain(): TapeFinalisation[] {
    const out = this.pending
    this.pending = []
    return out
  }

  step(frame: TapeFrame): TapeStepOutput {
    if (frame.plane !== this.plane) return NO_OUTPUT
    const boxOf = new Map(frame.dets.map((d) => [d.id, d.b]))
    const outputs: TapeTrackOutput[] = []
    for (const l of frame.live) {
      if (l.det === undefined) continue
      const box = boxOf.get(l.det)
      if (box === undefined) continue
      // `frame.live[]` is built from `FrameProcessorResult.tracked`, which the
      // live tracker already restricted to confirmed tracks (the tracker's own
      // confirmed-emit gate before D683; tracker v2's L1 emits only confirmed
      // tracklets) — the tape never recorded a below-`minHits` one, so
      // `true` here is the same "emitted as a track" fact as ProcessorTracker's
      // (M2, fix round 1), not a re-derivation of anything the tape lacks.
      outputs.push({ liveId: l.trk, detectionId: l.det, box, kind: 'bound', confirmed: true })
    }
    return { outputs, finalised: this.drain() }
  }

  finish(_endT: number): TapeFinalOutput {
    return { finalised: this.drain() }
  }
}
