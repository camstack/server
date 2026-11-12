import type { HmEntitySpec } from './hm-entity-spec.js'
import { channelIndexFromAddress } from './hm-cold-start.js'

const ACT_PREFIX = 'act-'

function channelIndex(key: string): number {
  const suffix = channelIndexFromAddress(key.slice(ACT_PREFIX.length))
  if (suffix === null) return Number.MAX_SAFE_INTEGER
  const parsed = Number(suffix)
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}

/**
 * Which child a Homematic container stands for.
 *
 * A device with relay channels stands for the first relay (lowest channel
 * index), so a two-relay switch is not left to the namesake tie-break. A
 * key-only device (no actuator) stands for its event-emitter. Anything else
 * declares nothing and the shared heuristic decides.
 */
export function hmPrimaryChildKeys(specs: readonly HmEntitySpec[]): readonly string[] {
  const relays = specs
    .filter((spec) => spec.key.startsWith(ACT_PREFIX) && spec.config['kind'] === 'switch')
    .toSorted((a, b) => channelIndex(a.key) - channelIndex(b.key))
  const first = relays[0]
  if (first !== undefined) return [first.key]
  const hasActuator = specs.some((spec) => spec.key.startsWith(ACT_PREFIX))
  if (hasActuator) return []
  return specs.some((spec) => spec.key === 'events') ? ['events'] : []
}

/**
 * The preference to write, or null when the container already has one or
 * there is nothing to declare. An operator pick is a different column.
 */
export function preferenceToStamp(
  stored: readonly string[] | undefined,
  declared: readonly string[],
): readonly string[] | null {
  if (stored !== undefined && stored.length > 0) return null
  if (declared.length === 0) return null
  return declared
}
