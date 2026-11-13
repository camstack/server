/**
 * The cap vocabulary generated from the caps' declarations (D1050) is the map
 * that used to be hand-written (D920): the fixture is that map, serialised
 * from the last hand-written commit. Same caps, ids, labels, phrases, args,
 * offers, effects, triggers and excuses — and the device caps in the same
 * picker order. The ONLY differences are the steps #524 added on purpose
 * (config methods #517 had left out), listed below: each must exist, and the
 * excuse it replaced must be gone.
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

/** Actions #524 added after the snapshot, by cap, with the method each calls. */
const ADDED_ACTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  ptz: {
    'ptz.savePreset': 'savePreset',
    'ptz.setHomePreset': 'setHomePreset',
    'ptz.captureHomeHere': 'captureHomeHere',
    'ptz.setHomeReturn': 'setHomeReturn',
  },
  'heat-pump-control': {
    'heatPump.circuitOperationMode': 'setCircuitOperationMode',
    'heatPump.circuitHeatCoolMode': 'setCircuitHeatCoolMode',
    'heatPump.circuitSummerWinter': 'setCircuitSummerWinter',
    'heatPump.circuitComfortSetpoint': 'setCircuitComfortSetpoint',
    'heatPump.circuitEcoSetpoint': 'setCircuitEcoSetpoint',
    'heatPump.circuitMaxFlowTemp': 'setCircuitMaxFlowTemp',
    'heatPump.dhwOperationMode': 'setDhwOperationMode',
    'heatPump.dhwTemperatureLevel': 'setDhwTemperatureLevel',
    'heatPump.dhwChargeDuration': 'setDhwChargeDuration',
    'heatPump.extraHotWater': 'startExtraHotWater',
  },
}

/**
 * Caps declared AFTER the fixture was taken (the fixture is a frozen snapshot of
 * the hand-written map, it never grows). Each must be in the generated map; the
 * comparisons against the fixture leave them out.
 */
const CAPS_ADDED_SINCE_FIXTURE: readonly string[] = ['energy-system']

function actionsOf(entry: unknown): readonly JsonRecord[] {
  const actions = isRecord(entry) ? entry['actions'] : undefined
  return Array.isArray(actions) ? actions.filter(isRecord) : []
}

function excusesOf(entry: unknown): JsonRecord {
  const excuses = isRecord(entry) ? entry['notOperatorFacing'] : undefined
  return isRecord(excuses) ? excuses : {}
}

/** The current entry with #524's additions taken out, and their excuses put back. */
function withoutAdditions(cap: string, entry: unknown, before: unknown): unknown {
  const added = ADDED_ACTIONS[cap]
  if (added === undefined || !isRecord(entry)) return entry
  const kept = actionsOf(entry).filter((a) => !(String(a['id']) in added))
  const restored = Object.fromEntries(
    Object.entries(excusesOf(before)).filter(([method]) => Object.values(added).includes(method)),
  )
  const excuses = { ...excusesOf(entry), ...restored }
  const { actions: _a, notOperatorFacing: _n, ...rest } = entry
  return {
    ...rest,
    ...(kept.length > 0 ? { actions: kept } : {}),
    ...(Object.keys(excuses).length > 0 ? { notOperatorFacing: excuses } : {}),
  }
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
    const generated = Object.keys(now).filter((cap) => !CAPS_ADDED_SINCE_FIXTURE.includes(cap))
    expect(generated.toSorted()).toEqual(Object.keys(before).toSorted())
    for (const cap of CAPS_ADDED_SINCE_FIXTURE) expect(now[cap], cap).toBeDefined()
  })

  it('is, cap by cap, the hand-written entry — apart from the listed additions', () => {
    for (const cap of Object.keys(before)) {
      expect({ cap, entry: withoutAdditions(cap, now[cap], before[cap]) }).toEqual({
        cap,
        entry: before[cap],
      })
    }
  })

  it('carries every listed addition, calling its method, with no excuse left on that method', () => {
    for (const [cap, added] of Object.entries(ADDED_ACTIONS)) {
      const byId = new Map(actionsOf(now[cap]).map((a) => [String(a['id']), a['method']]))
      for (const [id, method] of Object.entries(added)) {
        expect({ cap, id, method: byId.get(id) }).toEqual({ cap, id, method })
        expect({ cap, method, excuse: excusesOf(now[cap])[method] }).toEqual({
          cap,
          method,
          excuse: undefined,
        })
      }
    }
  })

  it('draws the device caps in the hand-written picker order', () => {
    expect(deviceCaps(now).filter((cap) => !CAPS_ADDED_SINCE_FIXTURE.includes(cap))).toEqual(
      deviceCaps(before),
    )
  })
})
