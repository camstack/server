/**
 * Which skill a request is for (planning#422). Several skills share one set of URLs, so a
 * request is resolved in this order:
 *
 *   1. the instance id in the PATH (`/directive/:instanceId`): explicit, nothing else is consulted;
 *   2. the `X-CamStack-Ingress` header, matched against each enabled skill's own token: a
 *      Lambda that already sends its token reaches its skill with no URL change;
 *   3. the LEGACY skill (`export-alexa`) when it exists and is enabled: the URLs a skill linked
 *      before multi-instance still answer it. Its own ingress check still applies afterwards.
 *
 * A path that names an unknown or disabled skill resolves to nothing: it never falls through to
 * another skill. A skill added later is never reached by the fallback.
 */
import { verifyIngressToken } from './ingress-token.js'

/** What the resolver needs to know about one skill. */
export interface RoutableSkill {
  readonly id: string
  readonly enabled: boolean
  /** The skill's ingress token; empty when it has none yet. */
  readonly ingressToken: string
}

/** What a request offers to identify its skill. */
export interface SkillLookup {
  readonly pathInstanceId: string | undefined
  readonly ingressHeader: string | undefined
}

/** The first skill, which keeps the pre-multi URLs. */
export const LEGACY_SKILL_ID = 'export-alexa'

export function pickSkill<T extends RoutableSkill>(
  skills: readonly T[],
  lookup: SkillLookup,
): T | null {
  if (lookup.pathInstanceId !== undefined) {
    return skills.find((s) => s.id === lookup.pathInstanceId && s.enabled) ?? null
  }
  const header = lookup.ingressHeader
  if (header !== undefined && header !== '') {
    const byToken = skills.find(
      (s) => s.enabled && s.ingressToken !== '' && verifyIngressToken(s.ingressToken, header),
    )
    if (byToken !== undefined) return byToken
  }
  return skills.find((s) => s.id === LEGACY_SKILL_ID && s.enabled) ?? null
}
