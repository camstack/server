#!/usr/bin/env tsx
/**
 * Every device type has a card, or a named reason it has none.
 *
 * A device type nobody mapped to a shell card falls to the legacy hero without a
 * word (gateway and heat-pump did, once). This guard asks the real resolver
 * (`connectedCardKindOf`) for every `DeviceType` member, given every cap the
 * resolver can look for: a type that still resolves to no card must be in
 * `DEVICE_TYPE_CARD_EXEMPTIONS` with the surface that draws it instead. An
 * exemption for a type that DOES resolve is an error too (a stale excuse), and
 * so is one naming a type that no longer exists.
 *
 * Usage: npx tsx scripts/check-device-type-card-coverage.ts
 */
import { DeviceType } from '@dominevo/types'
import { connectedCardKindOf } from '../packages/ui-library/src/composites/device-card/connected/connected-card-kind.js'
import { CAP_NAMES } from '../packages/types/src/generated/addon-cap-facts.js'
import { isMain } from './lib/family-baseline.js'

/** The device types the shell cards do not resolve, and what draws each one instead. */
export const DEVICE_TYPE_CARD_EXEMPTIONS: Readonly<Partial<Record<DeviceType, string>>> = {
  camera: 'CameraBody: the stream panel, not a shell card',
  sensor:
    'ConnectedSensorCard: the readings card, drawn from the hero model rather than from a cap',
  generic: 'HeroBody: the model-driven hero card (no cap names this type)',
  presence: 'HeroBody: the model-driven hero card (no cap names this type)',
  vehicle: 'HeroBody: the model-driven hero card (no cap names this type)',
}

/** Every cap name the resolver compares against by type (`ir-transmitter` is left out: it resolves ANY type, so it would hide the gaps); a type resolving to nothing with all of them has no card. */
export const RESOLVER_CAPS: readonly string[] = [
  'switch',
  'running-state',
  'cover',
  'dishwasher',
  'media-player',
  'vacuum-control',
  'water-heater',
  'lawn-mower-control',
  'climate-control',
  'heating-valve',
  'heat-pump-status',
  'energy-system',
  'lock-control',
  'alarm-panel',
  'humidifier',
  'valve',
  'pet-feeder',
  'pet-fountain',
  'weather',
  'weather-station',
  'button',
  'update',
  'script-runner',
  'automation-control',
  'control',
  'event-emitter',
  'image',
  'notifier',
  'workload',
]

/** Pure: the names in `list` that are not a real capability (a renamed or removed cap would leave a dead entry that hides a gap). */
export function unknownCaps(list: readonly string[], real: readonly string[]): string[] {
  const known = new Set(real)
  return list.filter((name) => !known.has(name))
}

export interface CoverageProblem {
  readonly type: string
  readonly problem: string
}

/** Pure: the problems given the resolver and the exemption table. */
export function coverageProblems(
  types: readonly string[],
  resolves: (type: string) => boolean,
  exemptions: Readonly<Record<string, string | undefined>>,
): CoverageProblem[] {
  const known = new Set(types)
  const problems: CoverageProblem[] = []
  for (const type of types) {
    const exempt = exemptions[type]
    if (resolves(type) && exempt !== undefined)
      problems.push({ type, problem: 'is exempt but resolves to a card: drop the exemption' })
    if (!resolves(type) && (exempt === undefined || exempt.trim() === ''))
      problems.push({ type, problem: 'resolves to no card and has no named exemption' })
  }
  for (const type of Object.keys(exemptions))
    if (!known.has(type)) problems.push({ type, problem: 'is exempt but is not a DeviceType' })
  return problems
}

function main(): number {
  const problems = coverageProblems(
    Object.values(DeviceType),
    (type) => connectedCardKindOf(type, null, RESOLVER_CAPS) !== null,
    DEVICE_TYPE_CARD_EXEMPTIONS,
  )
  for (const name of unknownCaps(RESOLVER_CAPS, CAP_NAMES))
    problems.push({ type: name, problem: 'is in RESOLVER_CAPS but is not a capability' })
  for (const p of problems) console.error(`check-device-type-card-coverage: ${p.type} ${p.problem}`)
  if (problems.length === 0) console.log('check-device-type-card-coverage: ok')
  return problems.length === 0 ? 0 : 1
}

if (isMain(import.meta.url)) process.exit(main())
