/**
 * The Retrain page's frame state, with undo / redo.
 *
 * `setEditor` keeps the `useState` shape the page already uses — a value or
 * an updater — and records every call as one undo step. Seeding a frame
 * (`resetEditor`) starts a fresh history: undo never walks back into the
 * previous frame. Selection (`selectOnly`) and the canvas's live drag
 * (`beginGesture` / `updateGesture` / `endGesture`) are recorded as the
 * history module says: selection never, a drag once.
 */
import { useCallback, useState } from 'react'
import type { EditorState } from './lib/retrain-editor.js'
import {
  beginGesture as beginStep,
  canRedo,
  canUndo,
  commit,
  endGesture as endStep,
  type History,
  historyOf,
  redo as redoStep,
  replacePresent,
  transient,
  undo as undoStep,
} from './lib/retrain-history.js'

type Update = EditorState | ((current: EditorState) => EditorState)

export interface RetrainEditorHistory {
  readonly editor: EditorState
  /** An edit — one undo step. */
  readonly setEditor: (update: Update) => void
  /** A new frame — a fresh history. */
  readonly resetEditor: (state: EditorState) => void
  /** A change that is not an edit (selection). */
  readonly selectOnly: (update: Update) => void
  readonly beginGesture: () => void
  readonly updateGesture: (update: Update) => void
  readonly endGesture: () => void
  readonly undo: () => void
  readonly redo: () => void
  readonly canUndo: boolean
  readonly canRedo: boolean
}

function apply(update: Update, current: EditorState): EditorState {
  return typeof update === 'function' ? update(current) : update
}

export function useRetrainEditorHistory(initial: () => EditorState): RetrainEditorHistory {
  const [history, setHistory] = useState<History<EditorState>>(() => historyOf(initial()))
  const setEditor = useCallback((update: Update) => {
    setHistory((h) => commit(h, apply(update, h.present)))
  }, [])
  const resetEditor = useCallback((state: EditorState) => {
    setHistory(historyOf(state))
  }, [])
  const selectOnly = useCallback((update: Update) => {
    setHistory((h) => replacePresent(h, apply(update, h.present)))
  }, [])
  const beginGesture = useCallback(() => {
    setHistory((h) => beginStep(h))
  }, [])
  const updateGesture = useCallback((update: Update) => {
    setHistory((h) => transient(h, apply(update, h.present)))
  }, [])
  const endGesture = useCallback(() => {
    setHistory((h) => endStep(h))
  }, [])
  const undo = useCallback(() => {
    setHistory((h) => undoStep(h))
  }, [])
  const redo = useCallback(() => {
    setHistory((h) => redoStep(h))
  }, [])
  return {
    editor: history.present,
    setEditor,
    resetEditor,
    selectOnly,
    beginGesture,
    updateGesture,
    endGesture,
    undo,
    redo,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
  }
}
