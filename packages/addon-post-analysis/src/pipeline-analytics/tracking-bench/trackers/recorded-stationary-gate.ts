/**
 * The stationary gate, replayed as RECORDED decisions (spec §5.2): the
 * registry, its persistence and its asynchronous wakes are not re-run. It
 * joins on detection ids, which is why the processor hands the gate
 * `detectionIds` (Task 3).
 */
import type {
  StationaryFrameGate,
  StationaryGateInput,
  StationaryGateOutcome,
} from '../../pipeline/frame-processor.js'
import type { TapeGate } from '../tape-schema.js'

export class RecordedStationaryGate implements StationaryFrameGate {
  private strong: ReadonlySet<string> = new Set()
  private weak: ReadonlySet<string> = new Set()

  load(gate: TapeGate | undefined): void {
    this.strong = new Set(gate?.strong.map((s) => s.det) ?? [])
    this.weak = new Set(gate?.weak ?? [])
  }

  filter(input: StationaryGateInput): StationaryGateOutcome {
    const suppressed = new Set<number>()
    const continuable = new Set<number>()
    ;(input.detectionIds ?? []).forEach((id, i) => {
      if (id === undefined) return
      if (this.weak.has(id)) {
        suppressed.add(i)
        continuable.add(i)
      } else if (this.strong.has(id)) {
        suppressed.add(i)
      }
    })
    return {
      suppressedIndices: suppressed,
      continuableIndices: continuable,
      confirmed: [],
      woken: [],
    }
  }
}
