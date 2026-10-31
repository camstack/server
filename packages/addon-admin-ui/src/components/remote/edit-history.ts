/**
 * The change history of a template being edited: what the editor shows now,
 * what undo goes back to, and what redo brings back. A new edit drops the redo
 * branch; an edit that changes nothing is not a step. Pure — the editor wires
 * it to `useReducer`.
 */
export interface EditHistory<T> {
  readonly past: readonly T[]
  readonly present: T
  readonly future: readonly T[]
}

export type EditHistoryAction<T> =
  | { readonly type: 'edit'; readonly value: T }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }

/** Oldest steps fall off past this many. */
export const EDIT_HISTORY_LIMIT = 100

export function startHistory<T>(value: T): EditHistory<T> {
  return { past: [], present: value, future: [] }
}

export const canUndo = <T>(history: EditHistory<T>): boolean => history.past.length > 0
export const canRedo = <T>(history: EditHistory<T>): boolean => history.future.length > 0

export function editHistoryReducer<T>(
  history: EditHistory<T>,
  action: EditHistoryAction<T>,
): EditHistory<T> {
  switch (action.type) {
    case 'edit': {
      if (Object.is(action.value, history.present)) return history
      return {
        past: [...history.past, history.present].slice(-EDIT_HISTORY_LIMIT),
        present: action.value,
        future: [],
      }
    }
    case 'undo': {
      const previous = history.past.at(-1)
      if (previous === undefined) return history
      return {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future],
      }
    }
    case 'redo': {
      const [next, ...rest] = history.future
      if (next === undefined) return history
      return {
        past: [...history.past, history.present],
        present: next,
        future: rest,
      }
    }
  }
}
