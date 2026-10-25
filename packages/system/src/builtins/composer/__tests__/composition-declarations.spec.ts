import { binaryCapability, DeviceType, temperatureSensorCapability } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { declarationFor, shapeOf, WithdrawalGate } from '../composition-declarations.js'
import { recordingLogger } from './fixtures.js'

const INPUT = {
  blockId: 'b1',
  name: 'Living room',
  target: { kind: 'new', type: DeviceType.Sensor },
  caps: [temperatureSensorCapability, binaryCapability],
} as const

/** The numeric ids the composer holds for its live composed devices. */
const LIVE_IDS: ReadonlyMap<string, number> = new Map([
  ['composed-b1', 901],
  ['composed-b2', 902],
])

function deviceIdOf(stableId: string): number | null {
  return LIVE_IDS.get(stableId) ?? null
}

describe('declarationFor', () => {
  it('mints the stableId from the block id and seeds the block name', () => {
    const d = declarationFor(INPUT)
    expect(d).toMatchObject({
      stableId: 'composed-b1',
      name: 'Living room',
      type: DeviceType.Sensor,
    })
  })
  it('the shape changes with the caps, not with the name', () => {
    expect(shapeOf({ ...INPUT, name: 'Other' })).toBe(shapeOf(INPUT))
    expect(shapeOf({ ...INPUT, caps: [binaryCapability] })).not.toBe(shapeOf(INPUT))
  })
})

describe('WithdrawalGate — a device leaves only when two applies agree (D49)', () => {
  const d1 = declarationFor(INPUT)
  const d2 = declarationFor({ ...INPUT, blockId: 'b2' })

  it('keeps a declaration missing from ONE apply', () => {
    const gate = new WithdrawalGate(recordingLogger().logger, deviceIdOf)
    gate.filter([d1, d2])
    expect(gate.filter([d1]).map((d) => d.stableId)).toEqual(['composed-b1', 'composed-b2'])
  })
  it('drops it on the second consecutive miss', () => {
    const gate = new WithdrawalGate(recordingLogger().logger, deviceIdOf)
    gate.filter([d1, d2])
    gate.filter([d1])
    expect(gate.filter([d1]).map((d) => d.stableId)).toEqual(['composed-b1'])
  })
  it('a withdrawn declaration stays withdrawn, and is not announced again', () => {
    const rec = recordingLogger()
    const gate = new WithdrawalGate(rec.logger, deviceIdOf)
    gate.filter([d1, d2])
    gate.filter([d1])
    gate.filter([d1])
    const before = rec.lines.length
    expect(gate.filter([d1]).map((d) => d.stableId)).toEqual(['composed-b1'])
    expect(rec.lines.length).toBe(before)
  })
  it('a reappearance resets the count', () => {
    const gate = new WithdrawalGate(recordingLogger().logger, deviceIdOf)
    gate.filter([d1, d2])
    gate.filter([d1])
    gate.filter([d1, d2])
    expect(gate.filter([d1]).map((d) => d.stableId)).toEqual(['composed-b1', 'composed-b2'])
  })
  it('every keep and withdraw line is tagged with the numeric id of that device', () => {
    const rec = recordingLogger()
    const gate = new WithdrawalGate(rec.logger, deviceIdOf)
    gate.filter([d1, d2])
    gate.filter([d1])
    gate.filter([d1])
    expect(rec.lines.map((l) => [l.level, l.extras?.tags?.['deviceId']])).toEqual([
      ['warn', 902],
      ['info', 902],
    ])
  })
})

describe('WithdrawalGate seeded from the persisted rows — a restart is not a miss (D49)', () => {
  const d1 = declarationFor(INPUT)
  const ROWS = [
    { id: 901, stableId: 'composed-b1' },
    { id: 903, stableId: 'composed-b3' },
  ]
  const noLiveDevice = (): number | null => null

  it('a persisted row missing from the FIRST apply after boot is kept', () => {
    const gate = new WithdrawalGate(recordingLogger().logger, noLiveDevice)
    gate.seed(ROWS)
    expect(gate.filter([d1]).map((d) => d.stableId)).toEqual(['composed-b1', 'composed-b3'])
  })
  it('it is withdrawn on the second consecutive miss', () => {
    const gate = new WithdrawalGate(recordingLogger().logger, noLiveDevice)
    gate.seed(ROWS)
    gate.filter([d1])
    expect(gate.filter([d1]).map((d) => d.stableId)).toEqual(['composed-b1'])
  })
  it('the kept row is held by a placeholder of its own stableId, never by a present declaration', () => {
    const gate = new WithdrawalGate(recordingLogger().logger, noLiveDevice)
    gate.seed(ROWS)
    const kept = gate.filter([d1])
    expect(kept[0]).toBe(d1)
    expect(kept[1]).toMatchObject({ stableId: 'composed-b3' })
  })
  it('the lines about a seeded row carry the persisted numeric id when no live device answers', () => {
    const rec = recordingLogger()
    const gate = new WithdrawalGate(rec.logger, noLiveDevice)
    gate.seed(ROWS)
    gate.filter([d1])
    gate.filter([d1])
    expect(rec.lines.map((l) => [l.level, l.extras?.tags?.['deviceId']])).toEqual([
      ['warn', 903],
      ['info', 903],
    ])
  })
  it('seeding a row the gate already knows does not reset its miss count', () => {
    const gate = new WithdrawalGate(recordingLogger().logger, noLiveDevice)
    gate.seed(ROWS)
    gate.filter([d1])
    gate.seed(ROWS)
    expect(gate.filter([d1]).map((d) => d.stableId)).toEqual(['composed-b1'])
  })
})
