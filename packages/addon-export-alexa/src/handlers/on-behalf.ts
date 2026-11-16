import { commandOrigin } from '@camstack/types/addon'
import type { VerifiedDirectiveIdentity } from '../directive-router.js'

/**
 * The origin claim for a device command an Alexa directive asked for: the linked
 * account whose token the directive carried. Pass it as the second argument of
 * `.mutate(input, …)`. Not a claim about who this addon is - the transport stamps that.
 */
export function alexaOrigin(identity: VerifiedDirectiveIdentity) {
  return commandOrigin({
    kind: 'on-behalf',
    source: 'alexa',
    principalId: identity.userId,
    ...(identity.username !== '' ? { principalName: identity.username } : {}),
  })
}
