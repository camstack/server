import { describe, expect, it } from 'vitest'
import {
  NC_ALARM_SYSTEM_EVENT_KINDS,
  NC_AUTHORABLE_SYSTEM_EVENT_KINDS,
  NC_BATTERY_CONSUMABLE_SYSTEM_EVENT_KINDS,
  NC_CONDITION_CATALOG,
  NcAlarmModeCoverageSchema,
  NcConditionsSchema,
  NcRuleInputSchema,
  NcRuleSchema,
  NcSystemEventKindSchema,
} from '../notification-rules.cap.js'

describe('notification-rules additive fields', () => {
  it('accepts an inline polygon custom zone', () => {
    const parsed = NcConditionsSchema.parse({
      customZones: [
        {
          kind: 'polygon',
          points: [
            { x: 0.1, y: 0.1 },
            { x: 0.9, y: 0.1 },
            { x: 0.5, y: 0.9 },
          ],
        },
      ],
    })
    expect(parsed.customZones?.[0]?.kind).toBe('polygon')
  })

  it('carries ownerUserId on input and disabledTargetIds default on the persisted rule', () => {
    const input = NcRuleInputSchema.parse({
      name: 'r',
      delivery: 'immediate',
      targets: [{ targetId: 't1' }],
      ownerUserId: 'u1',
    })
    expect(input.ownerUserId).toBe('u1')
    const rule = NcRuleSchema.parse({
      ...input,
      id: 'r1',
      createdBy: 'u1',
      createdAt: 1,
      updatedAt: 1,
    })
    expect(rule.disabledTargetIds).toEqual([])
    expect(rule.ownerUserId).toBe('u1')
  })

  it('exposes a customZones catalog descriptor with polygonDraw widget', () => {
    const d = NC_CONDITION_CATALOG.find((c) => c.id === 'customZones')
    expect(d?.valueType).toBe('polygonDraw')
    expect(d?.group).toBe('zones')
  })

  it('parses an occupancy condition with edge-op/count/sustain defaults', () => {
    const parsed = NcConditionsSchema.parse({ occupancy: {} })
    expect(parsed.occupancy?.op).toBe('became-occupied')
    expect(parsed.occupancy?.count).toBe(1)
    expect(parsed.occupancy?.sustainSeconds).toBe(15)
    expect(parsed.occupancy?.zoneId).toBeUndefined()
    expect(parsed.occupancy?.className).toBeUndefined()
  })

  it('exposes an occupancy catalog descriptor scoped to device-event', () => {
    const d = NC_CONDITION_CATALOG.find((c) => c.id === 'occupancy')
    expect(d?.appliesTo).toEqual(['device-event'])
    expect(d?.valueType).toBe('occupancy')
    expect(d?.group).toBe('occupancy')
    expect(d?.operator).toBe('anyOf')
  })

  it('exposes an audio catalog descriptor scoped to the immediate trigger', () => {
    // Audio has no delivery of its own — an `audio-window` subject rides
    // `immediate`. A descriptor claiming another trigger would render the
    // widget where the engine can never evaluate it.
    const d = NC_CONDITION_CATALOG.find((c) => c.id === 'audio')
    expect(d?.appliesTo).toEqual(['immediate'])
    expect(d?.valueType).toBe('audio')
    expect(d?.group).toBe('audio')
    expect(d?.operator).toBe('anyOf')
    // The fail-closed rule is the one an operator cannot infer from the
    // controls, so the served description has to carry it.
    expect(d?.description).toMatch(/NEITHER/)
  })

  it('names a widget for every condition an editor can author', () => {
    // A `NcConditions` key with no descriptor is a condition the catalog-driven
    // editors cannot render — and, worse, one `buildConditions` would strip
    // from a rule that already has it. `devices` is authored on its own tab and
    // still has its descriptor; only rule-level `schedule` has none.
    const authored = Object.keys(NcConditionsSchema.shape)
    const described = new Set(NC_CONDITION_CATALOG.map((d) => d.id))
    expect(authored.filter((key) => !described.has(key))).toEqual([])
  })

  it('adds one typed system-event family while keeping legacy rules valid', () => {
    const legacy = NcRuleInputSchema.parse({
      name: 'legacy',
      delivery: 'immediate',
      conditions: { classes: ['person'] },
      targets: [{ targetId: 't1' }],
    })
    expect(legacy.delivery).toBe('immediate')

    const system = NcRuleInputSchema.parse({
      name: 'infrastructure',
      delivery: 'system-event',
      conditions: {
        systemEvent: {
          kinds: ['device-offline', 'addon-update-available'],
          deviceIds: [104],
          deviceTypes: ['camera'],
          packageNames: ['@camstack/addon-pipeline'],
        },
      },
      targets: [{ targetId: 't1' }],
    })
    expect(system.conditions.systemEvent?.kinds).toEqual([
      'device-offline',
      'addon-update-available',
    ])
    // "Only my cameras" is a property of the RULE now — liveness itself is
    // emitted for every device type.
    expect(system.conditions.systemEvent?.deviceTypes).toEqual(['camera'])
    expect(NC_CONDITION_CATALOG.find((c) => c.id === 'systemEvent')).toMatchObject({
      group: 'system',
      valueType: 'systemEvent',
      appliesTo: ['system-event'],
    })
  })
})

/**
 * The generic liveness vocabulary, and the tail that only exists so durable
 * rows and an unmigrated rule survive being READ.
 */
describe('the system-event kind vocabulary', () => {
  it('offers completed updates and finished exports as authorable kinds', () => {
    for (const kind of ['addon-updated', 'server-updated', 'export-completed'] as const) {
      expect(NC_AUTHORABLE_SYSTEM_EVENT_KINDS).toContain(kind)
      expect(NcSystemEventKindSchema.parse(kind)).toBe(kind)
    }
  })

  it('offers the generic device kinds and no camera-worded ones', () => {
    for (const kind of ['device-online', 'device-offline', 'device-disabled', 'device-enabled']) {
      expect(NC_AUTHORABLE_SYSTEM_EVENT_KINDS).toContain(kind)
    }
    for (const legacy of ['camera-online', 'camera-offline', 'camera-disabled', 'camera-enabled']) {
      expect(NC_AUTHORABLE_SYSTEM_EVENT_KINDS).not.toContain(legacy)
    }
  })

  it('still PARSES a legacy kind — an old outbox row and an unmigrated rule', () => {
    // Not offered, still readable: the history view parses a row's frozen kind
    // back through this enum, and the operator's live rule carries these until
    // it is migrated. A kind that fails to parse loses the row or the rule.
    expect(NcSystemEventKindSchema.parse('camera-offline')).toBe('camera-offline')
    const rule = NcRuleInputSchema.parse({
      name: 'unmigrated',
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['camera-offline'] } },
      targets: [{ targetId: 't1' }],
    })
    expect(rule.conditions.systemEvent?.kinds).toEqual(['camera-offline'])
  })

  /**
   * The catalog is what `getConditionCatalog` serves, and it shipped for weeks
   * without `device-battery-low/normal` while the schema, the intake and the
   * admin's own group list all had them. Nothing compared the two lists.
   */
  it("the catalog's system-event options are EXACTLY the authorable kinds", () => {
    const options =
      NC_CONDITION_CATALOG.find((c) => c.id === 'systemEvent')?.options?.map((o) => o.value) ?? []
    expect(options.toSorted()).toEqual([...NC_AUTHORABLE_SYSTEM_EVENT_KINDS].toSorted())
  })

  it('names the battery/consumable family once, all authorable', () => {
    expect([...NC_BATTERY_CONSUMABLE_SYSTEM_EVENT_KINDS]).toEqual([
      'device-battery-low',
      'device-battery-normal',
      'device-consumable-low',
      'device-consumable-normal',
    ])
    for (const kind of NC_BATTERY_CONSUMABLE_SYSTEM_EVENT_KINDS) {
      expect(NC_AUTHORABLE_SYSTEM_EVENT_KINDS).toContain(kind)
    }
  })

  it('accepts an exclude-devices list beside the include list, and refuses an empty one', () => {
    const parsed = NcConditionsSchema.parse({
      systemEvent: { kinds: ['device-battery-low'], deviceIds: [1, 2], excludeDeviceIds: [2] },
    })
    expect(parsed.systemEvent?.excludeDeviceIds).toEqual([2])
    expect(() =>
      NcConditionsSchema.parse({
        systemEvent: { kinds: ['device-battery-low'], excludeDeviceIds: [] },
      }),
    ).toThrow()
  })

  it('rejects an empty deviceTypes list — absent means every type', () => {
    expect(() =>
      NcConditionsSchema.parse({ systemEvent: { kinds: ['device-offline'], deviceTypes: [] } }),
    ).toThrow()
  })

  /**
   * The alarm's three transitions are ORDINARY system-event kinds. The panel is
   * a device and its lifecycle is a fact about the installation, so "notify me
   * when the alarm goes off" is authored exactly like "notify me when a node
   * goes away" — no second rule family, no alarm branch in the engine.
   */
  it('offers the whole alarm lifecycle as authorable kinds', () => {
    for (const kind of NC_ALARM_SYSTEM_EVENT_KINDS) {
      expect(NcSystemEventKindSchema.parse(kind)).toBe(kind)
      expect(NC_AUTHORABLE_SYSTEM_EVENT_KINDS).toContain(kind)
    }
    // In lifecycle order, and INCLUDING the two that reach the operator while
    // there is still time to act: `alarm-arm-refused` (the mode was NOT armed,
    // and here is the sensor to go and shut) and `alarm-arming` (the exit
    // delay). Both were transitions this list shipped without. D630 adds the
    // entry delay, the self re-arm, a sensor bypass, and an arm that went ahead
    // unchecked.
    expect([...NC_ALARM_SYSTEM_EVENT_KINDS]).toEqual([
      'alarm-arm-refused',
      'alarm-check-failed',
      'alarm-arming',
      'alarm-armed',
      'alarm-pending',
      'alarm-triggered',
      'alarm-rearmed',
      'alarm-sensor-bypass',
      'alarm-disarmed',
    ])
  })

  it('authors a rule on alarm-triggered', () => {
    const rule = NcRuleInputSchema.parse({
      name: 'intrusion',
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['alarm-triggered'] } },
      targets: [{ targetId: 't1' }],
    })
    expect(rule.conditions.systemEvent?.kinds).toEqual(['alarm-triggered'])
  })
})

/**
 * A mode's coverage has to state what it does NOT arm, or "Away armed — 12
 * cameras" is a promise contradicted by a camera whose notifications are muted.
 */
describe('alarm mode coverage — the devices a mode does not actually arm', () => {
  it('defaults skippedDevices to an empty list so an older answer still parses', () => {
    const coverage = NcAlarmModeCoverageSchema.parse({
      mode: 'away',
      ruleCount: 2,
      allDevices: false,
      deviceIds: [101, 102],
    })
    expect(coverage.skippedDevices).toEqual([])
  })

  it('carries a reason per skipped device', () => {
    const coverage = NcAlarmModeCoverageSchema.parse({
      mode: 'away',
      ruleCount: 1,
      allDevices: true,
      deviceIds: [],
      skippedDevices: [
        { deviceId: 101, reason: 'muted' },
        { deviceId: 102, reason: 'detection-off' },
        { deviceId: 619, reason: 'offline' },
      ],
    })
    expect(coverage.skippedDevices.map((s) => s.reason)).toEqual([
      'muted',
      'detection-off',
      'offline',
    ])
  })

  it('refuses a reason nobody can render', () => {
    expect(() =>
      NcAlarmModeCoverageSchema.parse({
        mode: 'away',
        ruleCount: 1,
        allDevices: true,
        deviceIds: [],
        skippedDevices: [{ deviceId: 101, reason: 'because' }],
      }),
    ).toThrow()
  })
})
