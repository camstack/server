/**
 * When Restart is available in the script editor, and why it is not.
 *
 * Pure, and in its own file, for the same reason `core-block-status.ts` is: the
 * rule is the thing worth pinning, and pinning it must not require mounting
 * Monaco.
 *
 * The rule that matters: **a restart while the editor is dirty would run the
 * last SAVED code while the operator watched the new code on screen.** That is
 * the whole reason the loop is Compile → Save → Restart rather than one "run
 * it" verb, and it is the failure a green-looking restart would hide.
 */

import type { CoreBlock } from '@camstack/types'
import i18n from '../../i18n/index'

export interface RestartGateInput {
  /** The stored block, re-read from the list — null while creating. */
  readonly existing: CoreBlock | null
  /** Whether what is on screen differs from what the server accepted. */
  readonly dirty: boolean
  readonly saving: boolean
  readonly restarting: boolean
}

/**
 * Why Restart is unavailable, or null when it is available.
 *
 * A SENTENCE rather than a boolean, because every one of these states looks
 * identical on a greyed-out button and "why is this disabled" is the question
 * the operator actually has.
 */
export function restartReason({
  existing,
  dirty,
  saving,
  restarting,
}: RestartGateInput): string | null {
  if (existing === null) return i18n.t('helpers.restartGate.saveFirstNoProcess')
  if (saving) return i18n.t('helpers.restartGate.saving')
  if (restarting) return i18n.t('helpers.restartGate.restarting')
  if (dirty) {
    return i18n.t('helpers.restartGate.saveFirstDirty')
  }
  if (!existing.enabled) return i18n.t('helpers.restartGate.disabled')
  return null
}
