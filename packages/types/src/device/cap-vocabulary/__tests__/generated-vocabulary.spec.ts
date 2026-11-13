/**
 * The cap vocabulary generated from the caps' declarations (D1050) is the map
 * that used to be hand-written (D920): the fixture is that map, serialised
 * from the last hand-written commit. Same caps, ids, labels, phrases, args,
 * offers, effects, triggers and excuses — and the device caps in the same
 * picker order.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CAP_VOCABULARY } from '../vocabulary.js'

type JsonRecord = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readFixture(): JsonRecord {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('./fixtures/cap-vocabulary-before-524.json', import.meta.url), 'utf8'),
  )
  if (!isRecord(raw)) throw new Error('fixture is not a cap-keyed map')
  return raw
}

function asJson(value: unknown): JsonRecord {
  const raw: unknown = JSON.parse(JSON.stringify(value))
  if (!isRecord(raw)) throw new Error('not a cap-keyed map')
  return raw
}

function deviceCaps(map: JsonRecord): readonly string[] {
  return Object.entries(map)
    .filter(([, entry]) => isRecord(entry) && entry['scope'] === 'device')
    .map(([cap]) => cap)
}

describe('the generated cap vocabulary', () => {
  const before = readFixture()
  const now = asJson(CAP_VOCABULARY)

  it('has exactly the caps the hand-written map had', () => {
    expect(Object.keys(now).toSorted()).toEqual(Object.keys(before).toSorted())
  })

  it('is, cap by cap, the hand-written entry', () => {
    for (const cap of Object.keys(before)) {
      expect({ cap, entry: now[cap] }).toEqual({ cap, entry: before[cap] })
    }
  })

  it('draws the device caps in the hand-written picker order', () => {
    expect(deviceCaps(now)).toEqual(deviceCaps(before))
  })
})
