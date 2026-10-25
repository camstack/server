/**
 * The only thing a tape says about the light (decision 12): `ir` when the
 * layered scene condition (`scene/condition-resolver.ts`) says night or ir,
 * `day` otherwise. Twilight is `day`: the IR-cut has not flipped yet at the
 * band's edges, and a promotion may override the tag (§3.6).
 */
import type { SceneCondition } from '@camstack/types'
import type { TapeLighting } from '../tape-schema.js'

export function lightingFromCondition(condition: SceneCondition): TapeLighting {
  return condition === 'night' || condition === 'ir' ? 'ir' : 'day'
}
