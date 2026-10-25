/**
 * What the tracker was given and what it did with it, by detection id — the
 * facts a tracking tape records (D681, spec §3.2). Built only when
 * `process({ observe: true })` asks; the production path never pays for it
 * and nothing here feeds back into a decision.
 */
import type { BoundingBox, TrackState } from '@camstack/types'
import type { StationaryGateOutcome, TrackedDetectionOut } from './frame-processor.js'

export interface FrameGateStrongHold {
  readonly detectionId: string
  /** The registry entry of the ONE strong confirmation for exactly this box;
   *  absent when none or several matched (D681). */
  readonly entryId?: string
}

export interface FrameGateObservation {
  readonly strong: readonly FrameGateStrongHold[]
  readonly weak: readonly string[]
  readonly confirmed: readonly string[]
  readonly woken: readonly string[]
}

export interface FrameLiveBinding {
  readonly trackId: string
  readonly detectionId?: string
  readonly matched: boolean
  readonly state: TrackState
  readonly heldByLowScore?: true
}

export interface FrameObservation {
  readonly gate: FrameGateObservation
  readonly live: readonly FrameLiveBinding[]
}

/** The gate's answer, as `process` holds it — the gate's own outcome type,
 *  never a hand-kept copy that could drift from it. */
export type ObservedGateOutcome = StationaryGateOutcome

export interface ObserveFrameInput {
  /** Aligned with the gate's input detections. */
  readonly detectionIds: readonly (string | undefined)[]
  readonly gateBoxes: readonly BoundingBox[]
  readonly gate: ObservedGateOutcome
  readonly tracked: readonly TrackedDetectionOut[]
  /** Track ids the tracker emitted as held by a low-score box this frame. */
  readonly heldByLowScore: ReadonlySet<string>
}

function sameBox(a: BoundingBox, b: BoundingBox): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

export function observeFrame(input: ObserveFrameInput): FrameObservation {
  const strong: FrameGateStrongHold[] = []
  const weak: string[] = []
  input.detectionIds.forEach((detectionId, i) => {
    if (detectionId === undefined || !input.gate.suppressedIndices.has(i)) return
    if (input.gate.continuableIndices.has(i)) {
      weak.push(detectionId)
      return
    }
    // Only a STRONG confirmation can hold a strong-suppressed box, and several
    // entries may hold one box (the gate's pass is entry-driven): name the entry
    // only when exactly one strong holder matches, never guess between two.
    const box = input.gateBoxes[i]
    const holders =
      box === undefined
        ? []
        : input.gate.confirmed.filter((c) => c.strong && sameBox(c.observedBbox, box))
    const only = holders.length === 1 ? holders[0] : undefined
    strong.push(only === undefined ? { detectionId } : { detectionId, entryId: only.entryId })
  })
  return {
    gate: {
      strong,
      weak,
      confirmed: input.gate.confirmed.map((c) => c.entryId),
      woken: input.gate.woken.map((w) => w.entryId),
    },
    live: input.tracked.map((t) => ({
      trackId: t.trackId,
      ...(t.sourceDetectionId !== undefined ? { detectionId: t.sourceDetectionId } : {}),
      matched: t.matchedThisFrame,
      state: t.state,
      ...(input.heldByLowScore.has(t.trackId) ? { heldByLowScore: true as const } : {}),
    })),
  }
}
