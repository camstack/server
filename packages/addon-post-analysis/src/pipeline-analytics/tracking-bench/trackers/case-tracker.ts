/**
 * The ONE tracker every committed case replays through (D681, plan decision
 * 14). Today: the production `FrameProcessor`, rebuilt from the tape's recorded
 * inputs. D683 (the v2 tracker) either lives inside `FrameProcessor` — then
 * this line does not change — or points this slot at its own `TapeTracker`.
 * One slot, never a registry of trackers to rank.
 */
import { ProcessorTracker } from './processor-tracker.js'
import type { TapeTracker, TapeTrackerFactory } from './tape-tracker.js'

export const CASE_TRACKER: TapeTrackerFactory = (): TapeTracker => new ProcessorTracker()
