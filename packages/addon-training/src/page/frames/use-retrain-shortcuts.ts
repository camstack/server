/**
 * The Retrain page's keyboard: one window listener, the pure map in
 * `lib/retrain-shortcuts.ts`, and the page's callbacks.
 *
 * Box edits go through the editor reducer here (so the page only hands over
 * its history); everything that is the page's business — frames, completeness,
 * saving, zoom — is a callback. A key is swallowed (`preventDefault`) only when
 * it did something, so Tab still moves focus on a frame with no box and
 * Ctrl+S never reaches the browser's "save page" while a frame is open.
 */
import { type RefObject, useEffect, useRef } from 'react'
import {
  acceptAllDrafts,
  acceptBox,
  deleteBox,
  type EditorState,
  markModelError,
  selectBox,
  updateBox,
} from './lib/retrain-editor.js'
import { isTypingTarget, resolveShortcut, type ShortcutAction } from './lib/retrain-shortcuts.js'
import type { RetrainEditorHistory } from './use-retrain-editor-history.js'

export interface RetrainShortcutCallbacks {
  readonly history: RetrainEditorHistory
  /** `false` when there is no next/previous frame. */
  readonly onNextFrame: () => boolean
  readonly onPrevFrame: () => boolean
  /** `false` when there is no frame to mark. */
  readonly onToggleComplete: () => boolean
  /** `false` when nothing can be saved right now. */
  readonly onSave: () => boolean
  readonly onZoomIn: () => void
  readonly onZoomOut: () => void
  readonly onZoomFit: () => void
}

/** The neighbour of the selected box, wrapping; the first one when none is. */
function cycle(state: EditorState, step: 1 | -1): string | null {
  const n = state.boxes.length
  if (n === 0) return null
  const at = state.boxes.findIndex((b) => b.key === state.selectedKey)
  const next = at < 0 ? (step === 1 ? 0 : n - 1) : (at + step + n) % n
  return state.boxes[next]?.key ?? null
}

/** Run one action. `true` when it did something. */
export function applyRetrainShortcut(
  action: ShortcutAction,
  cb: RetrainShortcutCallbacks,
): boolean {
  const { history } = cb
  const selected = history.editor.selectedKey
  switch (action.kind) {
    case 'next-frame':
      return cb.onNextFrame()
    case 'prev-frame':
      return cb.onPrevFrame()
    case 'toggle-complete':
      return cb.onToggleComplete()
    case 'save':
      return cb.onSave()
    case 'undo':
      if (!history.canUndo) return false
      history.undo()
      return true
    case 'redo':
      if (!history.canRedo) return false
      history.redo()
      return true
    case 'zoom-in':
      cb.onZoomIn()
      return true
    case 'zoom-out':
      cb.onZoomOut()
      return true
    case 'zoom-fit':
      cb.onZoomFit()
      return true
    case 'accept-all':
      history.setEditor((s) => acceptAllDrafts(s))
      return true
    case 'select-next':
    case 'select-prev': {
      const key = cycle(history.editor, action.kind === 'select-next' ? 1 : -1)
      if (key === null) return false
      history.selectOnly((s) => selectBox(s, key))
      return true
    }
    case 'deselect':
      if (selected === null) return false
      history.selectOnly((s) => selectBox(s, null))
      return true
    default:
      break
  }
  if (selected === null) return false
  switch (action.kind) {
    case 'delete':
      history.setEditor((s) => deleteBox(s, selected))
      return true
    case 'set-class':
      history.setEditor((s) => updateBox(s, selected, { macroClass: action.macroClass }))
      return true
    case 'accept':
      history.setEditor((s) => acceptBox(s, selected))
      return true
    case 'toggle-model-error':
      history.setEditor((s) => markModelError(s, selected))
      return true
    default:
      return false
  }
}

/**
 * Is the event NOT from another dialog stacked on top of the one `scope` lives
 * in (the unsaved-changes confirm)? Such a dialog must not feed keys to the
 * editor below it.
 */
function inScope(event: KeyboardEvent, scope: RefObject<HTMLElement | null> | undefined): boolean {
  const own = scope?.current?.closest('dialog') ?? null
  const target = event.target
  const from = target instanceof Element ? target.closest('dialog') : null
  return from === null || from === own
}

/** Bind the keyboard while `enabled` (a frame is open). */
export function useRetrainShortcuts(
  enabled: boolean,
  callbacks: RetrainShortcutCallbacks,
  scope?: RefObject<HTMLElement | null>,
): void {
  const latest = useRef(callbacks)
  latest.current = callbacks
  useEffect(() => {
    if (!enabled) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || !inScope(event, scope)) return
      const action = resolveShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        typing: isTypingTarget(event.target),
      })
      if (action === null) return
      if (applyRetrainShortcut(action, latest.current)) event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [enabled, scope])
}
