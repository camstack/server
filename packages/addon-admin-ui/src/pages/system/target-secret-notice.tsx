import { useTranslation } from 'react-i18next'
/**
 * What the target form says about a stored secret the hub may refuse to
 * reuse (ADR 0634): a save that changes where a target sends, with a secret
 * left redacted, is refused — the stored credential only ever goes where it
 * was typed for.
 *
 *  - `refusal`: the hub's own sentence, verbatim, next to the fields, plus the
 *    secrets still to re-type. Never folded into the generic save error: that
 *    one reads as "try again", and trying again is refused again.
 *  - `edited` only: a hint BEFORE the round trip, naming the DESTINATION
 *    fields the operator changed — the kind publishes them
 *    (`TargetKind.destinationKeys`). Against an older hub that does not,
 *    every non-secret edit is named, and the sentence keeps its "if".
 */

interface TargetSecretNoticeProps {
  /** The hub's refusal message, or null. */
  readonly refusal: string | null
  /** Labels of the destination fields the operator changed. */
  readonly edited: readonly string[]
  /** Labels of the secrets a save would NOT send. */
  readonly reenter: readonly string[]
}

export function TargetSecretNotice({ refusal, edited, reenter }: TargetSecretNoticeProps) {
  const { t } = useTranslation()
  const toType = reenter.length > 0 ? `Re-type: ${reenter.join(', ')}.` : null
  if (refusal !== null) {
    return (
      <div
        className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        data-testid="target-secret-refusal"
        role="alert"
      >
        <p className="font-semibold">
          {t(
            'system.targetSecretNotice.theHubNeedsTheSecret',
            'The hub needs the secret again — nothing was saved.',
          )}
        </p>
        <p className="mt-1">{refusal}</p>
        {toType !== null ? <p className="mt-1 font-medium">{toType}</p> : null}
      </div>
    )
  }
  if (edited.length === 0 || toType === null) return null
  return (
    <p className="text-[11px] text-warning" data-testid="target-secret-reenter">
      {t('system.targetSecretNotice.changed', { fields: edited.join(', '), toType })}
    </p>
  )
}
