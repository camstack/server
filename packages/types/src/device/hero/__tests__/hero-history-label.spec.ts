/**
 * A foot button named for what the device keeps ("Meals", "Access", "Cycles")
 * promises a recorded series of exactly that. The name is only honest when the
 * cap that serves the device type declares the field in its `history` block
 * (D850); otherwise the button opens a history without the thing it named.
 */
import { describe, expect, it } from 'vitest'
import { dishwasherCapability } from '../../../capabilities/dishwasher.cap.js'
import { lockControlCapability } from '../../../capabilities/lock-control.cap.js'
import { petFeederCapability } from '../../../capabilities/pet-feeder.cap.js'
import { runningStateCapability } from '../../../capabilities/running-state.cap.js'
import { DeviceType } from '../../device-type.js'
import { build } from './hero-test-kit.js'

interface HistoryBacking {
  readonly type: DeviceType
  readonly label: string
  readonly fields: Readonly<Record<string, { readonly kind: string }>>
  readonly field: string
  readonly kind: string
}

const BACKINGS: readonly HistoryBacking[] = [
  {
    type: DeviceType.PetFeeder,
    label: 'Meals',
    fields: petFeederCapability.history.fields,
    field: 'feeding',
    kind: 'boolean',
  },
  {
    type: DeviceType.Lock,
    label: 'Access',
    fields: lockControlCapability.history.fields,
    field: 'state',
    kind: 'enum',
  },
  {
    type: DeviceType.Washer,
    label: 'Cycles',
    fields: runningStateCapability.history.fields,
    field: 'running',
    kind: 'boolean',
  },
  {
    type: DeviceType.Dishwasher,
    label: 'Cycles',
    fields: dishwasherCapability.history.fields,
    field: 'state',
    kind: 'enum',
  },
]

describe('hero history label — backed by a recorded series', () => {
  for (const b of BACKINGS) {
    it(`"${b.label}" on a ${b.type} is recorded as ${b.field} (${b.kind})`, () => {
      expect(build(b.type, []).historyLabel.en).toBe(b.label)
      expect(b.fields[b.field]?.kind).toBe(b.kind)
    })
  }

  it('a feeder records when the pet eats, not only how much food is left', () => {
    expect(petFeederCapability.history.fields).toHaveProperty('eating', { kind: 'boolean' })
  })
})
