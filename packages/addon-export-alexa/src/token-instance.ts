/**
 * Whether a verified account-link token may be used on the skill a request reached
 * (planning#415 T3, D1047). The hub states the instance a link was made for
 * (`oauthVerifyAccessToken` → `instanceId`, absent = the default instance); a skill
 * refuses a token made for another one, with a named reason.
 *
 * A token that names NO instance was made before links named one, or through a Lambda that
 * does not pass `instance=`. It is the default instance's (D1047). Before D1047 every link was
 * made that way, also for a second skill — and that skill's own ledger recorded the user when
 * its Lambda delivered the grant. So such a token is also served by a non-default skill whose
 * ledger already lists the user: those links keep working, nothing is re-linked. A NEW user on a
 * non-default skill needs a token that names it.
 */
import { oauthLinkServesInstance } from '@camstack/types'

/** The addon id, which is also the id of the default instance. */
export const ALEXA_ADDON_ID = 'export-alexa'

/** What a verified token says about the instance it was linked to. */
export interface TokenInstanceClaim {
  readonly userId: string
  /** From `oauthVerifyAccessToken`; absent = the default instance. */
  readonly instanceId?: string | undefined
}

/** Why a token was refused on this skill. */
export type TokenInstanceRefusal =
  /** The token names another instance. */
  | 'token-instance-mismatch'
  /** The token names no instance, this is not the default skill and its ledger does not list the user. */
  | 'token-instance-unstated'

export type TokenInstanceVerdict =
  | { readonly kind: 'serves' }
  | { readonly kind: 'refused'; readonly reason: TokenInstanceRefusal }

export interface TokenInstanceSkill {
  readonly id: string
  /** Whether this skill's link ledger already lists the user. */
  readonly hasLinkedUser: (userId: string) => boolean
}

export function judgeTokenInstance(
  token: TokenInstanceClaim,
  skill: TokenInstanceSkill,
): TokenInstanceVerdict {
  if (token.instanceId !== undefined) {
    return oauthLinkServesInstance({ instanceId: token.instanceId }, skill.id, ALEXA_ADDON_ID)
      ? { kind: 'serves' }
      : { kind: 'refused', reason: 'token-instance-mismatch' }
  }
  if (skill.id === ALEXA_ADDON_ID) return { kind: 'serves' }
  return skill.hasLinkedUser(token.userId)
    ? { kind: 'serves' }
    : { kind: 'refused', reason: 'token-instance-unstated' }
}

/** The operator-facing sentence for a refusal, sent back to the Lambda and logged. */
export function describeTokenInstanceRefusal(reason: TokenInstanceRefusal): string {
  return reason === 'token-instance-mismatch'
    ? 'the account was linked to another skill instance of this hub'
    : 'the account link names no skill instance and this skill has not linked the account; update the skill Lambda and link again'
}
