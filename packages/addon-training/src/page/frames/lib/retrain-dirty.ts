/**
 * "Has the operator edited this frame since it was opened or last saved?" —
 * and the one rule that decides whether an action that would drop the edits
 * (←/→, close, reload) may go ahead.
 *
 * Dirtiness is a comparison of what a save WOULD send: the confirmed boxes and
 * the dismissed set. Selection, zoom, hover and unconfirmed drafts are not part
 * of it — an unconfirmed draft is never saved, so losing one loses nothing the
 * server ever held; accepting, moving, relabelling or deleting a box changes
 * the payload and is an edit.
 */

import { type EditorState, toSaveDismissed, toSavePayload } from './retrain-editor.js'

/** A stable string of what a save of `state` would send. */
export function editorSignature(state: EditorState): string {
  return JSON.stringify({
    annotations: toSavePayload(state),
    dismissed: toSaveDismissed(state).map((d) => d.ref),
  })
}

/** The editor differs from the baseline it was seeded (or last saved) with. */
export function isEditorDirty(state: EditorState, baseline: string): boolean {
  return editorSignature(state) !== baseline
}

/**
 * Run `proceed` — immediately when nothing would be lost, otherwise only after
 * the operator agrees to discard. Resolves `true` when `proceed` ran.
 */
export async function runGuarded(
  dirty: boolean,
  confirmDiscard: () => Promise<boolean>,
  proceed: () => void,
): Promise<boolean> {
  if (dirty && !(await confirmDiscard())) return false
  proceed()
  return true
}
