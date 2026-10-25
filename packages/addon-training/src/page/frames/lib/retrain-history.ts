/**
 * Undo / redo over the frame editor's state (`retrain-editor.ts`). Generic
 * and pure: snapshots of an immutable state, nothing else.
 *
 * Two rules shape it:
 *
 * - **A gesture is one step.** Dragging a box emits a state per pointer move;
 *   undoing that one move at a time would make undo useless for the edit it
 *   exists for. `beginGesture` remembers where the drag started, `transient`
 *   updates the picture without recording, `endGesture` records ONE step — or
 *   none, when the gesture changed nothing (it was a click).
 * - **Selection is not an edit.** `replacePresent` changes what is on screen
 *   without a step and without touching redo, so selecting a box between an
 *   undo and a redo does not throw the redo away.
 */

/** Steps kept. Older ones fall off the bottom. */
export const HISTORY_LIMIT = 100

export interface History<T> {
  readonly past: readonly T[]
  readonly present: T
  readonly future: readonly T[]
  /** The state a running gesture started from; `null` outside a gesture. */
  readonly gestureBase: T | null
}

export function historyOf<T>(present: T): History<T> {
  return { past: [], present, future: [], gestureBase: null }
}

function pushPast<T>(past: readonly T[], state: T): readonly T[] {
  const next = [...past, state]
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
}

/** Record an edit. A no-op edit (same reference) records nothing. */
export function commit<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h
  return { past: pushPast(h.past, h.present), present: next, future: [], gestureBase: null }
}

/** Change the picture without recording a step (selection). */
export function replacePresent<T>(h: History<T>, next: T): History<T> {
  return { ...h, present: next }
}

export function undo<T>(h: History<T>): History<T> {
  const previous = h.past[h.past.length - 1]
  if (previous === undefined) return h
  return {
    past: h.past.slice(0, -1),
    present: previous,
    future: [h.present, ...h.future],
    gestureBase: null,
  }
}

export function redo<T>(h: History<T>): History<T> {
  const [next, ...rest] = h.future
  if (next === undefined) return h
  return { past: pushPast(h.past, h.present), present: next, future: rest, gestureBase: null }
}

export function beginGesture<T>(h: History<T>): History<T> {
  return { ...h, gestureBase: h.present }
}

export function transient<T>(h: History<T>, next: T): History<T> {
  return { ...h, present: next }
}

export function endGesture<T>(h: History<T>): History<T> {
  const base = h.gestureBase
  if (base === null) return h
  if (base === h.present) return { ...h, gestureBase: null }
  return { past: pushPast(h.past, base), present: h.present, future: [], gestureBase: null }
}

export function canUndo<T>(h: History<T>): boolean {
  return h.past.length > 0
}

export function canRedo<T>(h: History<T>): boolean {
  return h.future.length > 0
}
