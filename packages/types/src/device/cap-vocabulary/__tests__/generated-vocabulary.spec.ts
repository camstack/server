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
  switch: { 'switch.toggle': 'toggle' },
  control: {
    'select.next': 'next',
    'select.previous': 'previous',
    'select.first': 'first',
    'select.last': 'last',
  },
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
    'heatPump.circuitControlType': 'setCircuitControlType',
    'heatPump.circuitTargetTemp': 'setCircuitTargetTemp',
    'heatPump.dhwLevelTemp': 'setDhwLevelTemp',
  },
}

/**
 * Caps declared AFTER the fixture was taken (the fixture is a frozen snapshot of
 * the hand-written map, it never grows). Each must be in the generated map; the
 * comparisons against the fixture leave them out.
 */
const CAPS_ADDED_SINCE_FIXTURE: readonly string[] = [
  'energy-system',
  'weather-station',
  'error',
  'tags',
  'siren',
  'workload',
  // #459 Q2: sleep and resync left `battery` / the device-type badges.
  'low-power-sleep',
  'resync',
  // #599 (D1062): the server-driven state refresh a provider implements per device.
  'device-state-refresh',
  // D1079-D1082: a vehicle device and where a device is.
  'location',
  'vehicle',
  // Retention P3: the retention-source catalog a data owner declares.
  'retention-source',
  // D1096: the apps a shell lists, and the per-provider source the aggregator reads.
  'app-source',
  'apps',
  // D1103: the cluster's day/night authority (sun or a light sensor).
  'daylight-phase',
]

/**
 * Method excuses that LEFT a cap after the snapshot, by cap: #459 Q2 moved the
 * camera wake off `battery` onto `low-power-sleep` (as `wakeUp`). The
 * comparison puts the fixture's excuse back.
 */
const MOVED_EXCUSES: Readonly<Record<string, readonly string[]>> = {
  battery: ['wakeForStream'],
}

/** The entry with the moved-away method excuses restored from the fixture. */
function withMovedExcusesRestored(cap: string, entry: unknown, before: unknown): unknown {
  const methods = MOVED_EXCUSES[cap]
  if (methods === undefined || !isRecord(entry)) return entry
  const restored = Object.fromEntries(
    Object.entries(excusesOf(before)).filter(([method]) => methods.includes(method)),
  )
  return { ...entry, notOperatorFacing: { ...excusesOf(entry), ...restored } }
}

function actionsOf(entry: unknown): readonly JsonRecord[] {
  const actions = isRecord(entry) ? entry['actions'] : undefined
  return Array.isArray(actions) ? actions.filter(isRecord) : []
}

function excusesOf(entry: unknown): JsonRecord {
  const excuses = isRecord(entry) ? entry['notOperatorFacing'] : undefined
  return isRecord(excuses) ? excuses : {}
}

/**
 * State entries (`state[].field`) declared after the snapshot, by cap. The
 * comparison leaves them out; the last spec requires each to be present.
 */
const ADDED_STATE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // The cell's charge state, beside the existing charging source (2026-11-20).
  battery: ['chargeState'],
}

function stateOf(entry: unknown): readonly JsonRecord[] {
  const state = isRecord(entry) ? entry['state'] : undefined
  return Array.isArray(state) ? state.filter(isRecord) : []
}

function withoutAddedState(cap: string, entry: unknown): unknown {
  const fields = ADDED_STATE_FIELDS[cap]
  if (fields === undefined || !isRecord(entry)) return entry
  return {
    ...entry,
    state: stateOf(entry).filter((s) => !fields.includes(String(s['field']))),
  }
}

/** Role overrides (`overrides.byRole`) added after the snapshot, by cap. */
const ADDED_ROLE_OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  switch: ['poe-port'],
}

function roleOverridesOf(entry: unknown): JsonRecord {
  const overrides = isRecord(entry) ? entry['overrides'] : undefined
  const byRole = isRecord(overrides) ? overrides['byRole'] : undefined
  return isRecord(byRole) ? byRole : {}
}

/** The entry with the listed role overrides taken out. */
function withoutAddedRoles(cap: string, entry: unknown): unknown {
  const roles = ADDED_ROLE_OVERRIDES[cap]
  if (roles === undefined || !isRecord(entry) || !isRecord(entry['overrides'])) return entry
  const byRole = Object.fromEntries(
    Object.entries(roleOverridesOf(entry)).filter(([role]) => !roles.includes(role)),
  )
  return { ...entry, overrides: { ...entry['overrides'], byRole } }
}

/** Methods declared after the snapshot with an excuse (`notOperatorFacing`), by cap. */
const ADDED_EXCUSES: Readonly<Record<string, readonly string[]>> = {
  switch: ['powerCycle'],
  'timed-run': ['setSettings'],
}

/** The entry with the listed method excuses taken out. */
function withoutAddedExcuses(cap: string, entry: unknown): unknown {
  const methods = ADDED_EXCUSES[cap]
  if (methods === undefined || !isRecord(entry)) return entry
  const excuses = Object.fromEntries(
    Object.entries(excusesOf(entry)).filter(([method]) => !methods.includes(method)),
  )
  const { notOperatorFacing: _n, ...rest } = entry
  return {
    ...rest,
    ...(Object.keys(excuses).length > 0 ? { notOperatorFacing: excuses } : {}),
  }
}

/** Actions whose `offeredWhen` gate was declared after the snapshot (D1058), by cap. */
const ADDED_OFFERED_WHEN: Readonly<Record<string, readonly string[]>> = {
  switch: ['switch.on', 'switch.off'],
  'power-source': ['powerSource.on', 'powerSource.off'],
}

/** The entry with the listed actions' `offeredWhen` gate taken out. */
function withoutAddedOfferedWhen(cap: string, entry: unknown): unknown {
  const ids = ADDED_OFFERED_WHEN[cap]
  if (ids === undefined || !isRecord(entry)) return entry
  const actions = actionsOf(entry).map((action) => {
    if (!ids.includes(String(action['id']))) return action
    const { offeredWhen: _o, ...rest } = action
    return rest
  })
  return { ...entry, actions }
}

/**
 * What a command leads to, declared after the snapshot (D1061): every action's
 * `sideEffects`, and the `effect` of the listed actions, by cap.
 */
const ADDED_EFFECTS: Readonly<Record<string, readonly string[]>> = {
  'fan-control': ['fan.preset'],
  'climate-control': ['climate.targetRange', 'climate.fanMode', 'climate.preset'],
  'media-player': [
    'media.play',
    'media.pause',
    'media.volume',
    'media.mute',
    'media.unmute',
    'media.shuffleOn',
    'media.shuffleOff',
    'media.repeat',
    'media.source',
  ],
  'pet-feeder': [
    'petFeeder.childLockOn',
    'petFeeder.childLockOff',
    'petFeeder.lightOn',
    'petFeeder.lightOff',
    'petFeeder.feedSoundOn',
    'petFeeder.feedSoundOff',
    'petFeeder.volume',
  ],
  'pet-fountain': ['petFountain.pumpOn', 'petFountain.pumpOff'],
  'pump-cycle': ['pumpCycle.on', 'pumpCycle.off', 'pumpCycle.onMinutes', 'pumpCycle.offMinutes'],
  'script-runner': ['script.stop'],
  'automation-control': ['haAutomation.enable', 'haAutomation.disable'],
}

/** The entry with the D1061 effects and holds taken out. */
function withoutAddedEffects(cap: string, entry: unknown): unknown {
  if (!isRecord(entry) || !Array.isArray(entry['actions'])) return entry
  const ids = ADDED_EFFECTS[cap] ?? []
  const actions = actionsOf(entry).map((action) => {
    const { sideEffects: _s, hold: _h, ...withoutSide } = action
    if (!ids.includes(String(action['id']))) return withoutSide
    const { effect: _e, ...rest } = withoutSide
    return rest
  })
  return { ...entry, actions }
}

/** The current entry with #524's additions taken out, and their excuses put back. */
function withoutAdditions(cap: string, current: unknown, before: unknown): unknown {
  const entry = withMovedExcusesRestored(
    cap,
    withoutAddedEffects(
      cap,
      withoutAddedOfferedWhen(
        cap,
        withoutAddedExcuses(cap, withoutAddedRoles(cap, withoutAddedState(cap, current))),
      ),
    ),
    before,
  )
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
      expect({
        cap,
        entry: withoutAdditions(cap, now[cap], before[cap]),
      }).toEqual({
        cap,
        entry: before[cap],
      })
    }
  })

  it('carries every listed state addition', () => {
    for (const [cap, fields] of Object.entries(ADDED_STATE_FIELDS)) {
      const present = stateOf(now[cap]).map((s) => String(s['field']))
      for (const field of fields)
        expect({ cap, field, present: present.includes(field) }).toEqual({
          cap,
          field,
          present: true,
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

  it('carries every listed role override', () => {
    for (const [cap, roles] of Object.entries(ADDED_ROLE_OVERRIDES)) {
      for (const role of roles)
        expect(roleOverridesOf(now[cap])[role], `${cap} ${role}`).toBeDefined()
    }
  })

  it('draws the device caps in the hand-written picker order', () => {
    expect(deviceCaps(now).filter((cap) => !CAPS_ADDED_SINCE_FIXTURE.includes(cap))).toEqual(
      deviceCaps(before),
    )
  })
})
