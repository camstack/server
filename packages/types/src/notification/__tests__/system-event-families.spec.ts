/**
 * THE PIN for the system-event families (D637). One table decides which family
 * each kind belongs to and which filters each family may carry; the hub
 * validator and both editors read it. Every claim below is asserted against the
 * schema's own enum, so a kind added to the cap without a family fails here.
 */
import { describe, expect, it } from 'vitest'
import {
  NC_AUTHORABLE_SYSTEM_EVENT_KINDS,
  NC_CONSUMABLE_LOW_PERCENT_MAX,
  NcSystemEventConditionSchema,
  NcSystemEventKindSchema,
} from '../../capabilities/notification-rules.cap.js'
import { NC_SYSTEM_EVENT_FILTER_KEYS, systemEventFilterApplies } from '../system-event-filters.js'
import {
  describeSystemEventFamilyProblem,
  NC_SYSTEM_EVENT_FAMILIES,
  NC_SYSTEM_EVENT_FAMILY,
  NC_SYSTEM_EVENT_FAMILY_FILTERS,
  NC_SYSTEM_EVENT_KIND_GROUP_SPECS,
  systemEventFamilyOf,
  systemEventFamilyProblems,
  systemEventKindNamesOf,
  systemEventKindsOfFamily,
} from '../system-event-families.js'

describe('every kind has exactly one family', () => {
  it('maps each AUTHORABLE kind to a family, and only the legacy tail to null', () => {
    for (const kind of NcSystemEventKindSchema.options) {
      const family = NC_SYSTEM_EVENT_FAMILY[kind]
      if (NC_AUTHORABLE_SYSTEM_EVENT_KINDS.includes(kind)) {
        expect(family, kind).not.toBeNull()
      } else {
        expect(family, kind).toBeNull()
      }
    }
  })

  it('pins the spec membership', () => {
    expect(systemEventKindsOfFamily('device-events')).toEqual([
      'device-offline',
      'device-online',
      'device-disabled',
      'device-enabled',
      'stream-offline',
      'stream-online',
      'device-battery-low',
      'device-battery-normal',
      'device-consumable-low',
      'device-consumable-normal',
      'detection-blind',
      'motion-noisy',
      'motion-calm',
      'package-llm-silent',
      'package-llm-answered',
      'recording-stalled',
      'recording-healthy',
      'recording-degraded',
      'device-attention-required',
      'device-attention-resolved',
    ])
    expect(systemEventKindsOfFamily('system')).toEqual([
      'node-offline',
      'node-online',
      'node-restarting',
      'node-inference-unavailable',
      'addon-crash-loop',
      'addon-update-available',
      'addon-updated',
      'server-update-available',
      'node-updating',
      'server-updated',
      'wrapper-update-available',
      'backup-completed',
      'export-completed',
      'storage-location-low',
      'storage-location-critical',
      'storage-location-ok',
      'alert-critical',
      'alert-error',
      'alert-critical-resolved',
      'rule-broken',
      'rule-repaired',
    ])
    expect(systemEventKindsOfFamily('alarm')).toEqual([
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

  it('groups every authorable kind exactly once, in the group of its own family', () => {
    const seen = NC_SYSTEM_EVENT_KIND_GROUP_SPECS.flatMap((group) =>
      group.kinds.map((kind) => ({ kind, family: group.family })),
    )
    expect(seen.map((s) => s.kind).toSorted()).toEqual(
      [...NC_AUTHORABLE_SYSTEM_EVENT_KINDS].toSorted(),
    )
    for (const { kind, family } of seen) expect(NC_SYSTEM_EVENT_FAMILY[kind], kind).toBe(family)
  })
})

describe('the per-family filter table agrees with the per-kind scoping', () => {
  it('allows a base filter for a family iff some kind of that family can be narrowed by it', () => {
    for (const family of NC_SYSTEM_EVENT_FAMILIES) {
      for (const filter of NC_SYSTEM_EVENT_FILTER_KEYS) {
        const derived = systemEventKindsOfFamily(family).some((k) =>
          systemEventFilterApplies(k, filter),
        )
        expect(
          NC_SYSTEM_EVENT_FAMILY_FILTERS[family].includes(filter),
          `${family} × ${filter}`,
        ).toBe(derived)
      }
    }
  })

  it('allows excludeDeviceIds only on device events', () => {
    expect(NC_SYSTEM_EVENT_FAMILY_FILTERS['device-events']).toContain('excludeDeviceIds')
    expect(NC_SYSTEM_EVENT_FAMILY_FILTERS.system).not.toContain('excludeDeviceIds')
    expect(NC_SYSTEM_EVENT_FAMILY_FILTERS.alarm).not.toContain('excludeDeviceIds')
  })

  it('the consumable threshold speaks ONLY about the consumable pair, on device-events (D642)', () => {
    const scoped = NcSystemEventKindSchema.options.filter((k) =>
      systemEventFilterApplies(k, 'consumableLowPercent'),
    )
    expect(scoped).toEqual(['device-consumable-low', 'device-consumable-normal'])
    expect(NC_SYSTEM_EVENT_FAMILY_FILTERS['device-events']).toContain('consumableLowPercent')
    expect(NC_SYSTEM_EVENT_FAMILY_FILTERS.system).not.toContain('consumableLowPercent')
    expect(NC_SYSTEM_EVENT_FAMILY_FILTERS.alarm).not.toContain('consumableLowPercent')
  })

  it('the hub accepts a threshold on a device-events rule and refuses it elsewhere (D642)', () => {
    expect(
      systemEventFamilyProblems({ kinds: ['device-consumable-low'], consumableLowPercent: 25 }),
    ).toEqual([])
    expect(
      systemEventFamilyProblems({ kinds: ['node-offline'], consumableLowPercent: 25 }),
    ).toEqual([{ code: 'filter-outside-family', filter: 'consumableLowPercent', family: 'system' }])
  })

  it('the schema stops at 95 — a rule above it could never recover (review M1)', () => {
    const parse = (consumableLowPercent: number) =>
      NcSystemEventConditionSchema.safeParse({
        kinds: ['device-consumable-low'],
        consumableLowPercent,
      }).success
    expect(NC_CONSUMABLE_LOW_PERCENT_MAX).toBe(95)
    expect(parse(95)).toBe(true)
    expect(parse(96)).toBe(false)
    expect(parse(0)).toBe(false)
  })

  it('export-completed is no longer narrowed by device (spec decision 5)', () => {
    expect(systemEventFilterApplies('export-completed', 'deviceIds')).toBe(false)
  })
})

describe('systemEventFamilyOf', () => {
  it('names the one family of a single-family selection', () => {
    expect(systemEventFamilyOf(['device-offline', 'device-battery-low'])).toEqual({
      kind: 'family',
      family: 'device-events',
    })
    expect(systemEventFamilyOf(['alarm-triggered'])).toEqual({ kind: 'family', family: 'alarm' })
  })
  it('is mixed across families, on a legacy kind, on an unknown kind, and on nothing', () => {
    expect(systemEventFamilyOf(['device-offline', 'node-offline'])).toEqual({ kind: 'mixed' })
    expect(systemEventFamilyOf(['camera-offline'])).toEqual({ kind: 'mixed' })
    expect(systemEventFamilyOf(['a-kind-from-a-newer-hub'])).toEqual({ kind: 'mixed' })
    expect(systemEventFamilyOf([])).toEqual({ kind: 'mixed' })
  })
  it('reads kind names off an UNTYPED condition', () => {
    expect(systemEventKindNamesOf({ kinds: ['node-offline', 3] })).toEqual(['node-offline'])
    expect(systemEventKindNamesOf(undefined)).toBeUndefined()
    expect(systemEventKindNamesOf({ kinds: 'node-offline' })).toBeUndefined()
  })
})

describe('systemEventFamilyProblems — what the hub refuses', () => {
  it('accepts a single-family condition with only its own filters', () => {
    expect(
      systemEventFamilyProblems({ kinds: ['device-battery-low'], excludeDeviceIds: [3615] }),
    ).toEqual([])
    expect(systemEventFamilyProblems({ kinds: ['node-offline'], nodeIds: ['hub'] })).toEqual([])
    expect(systemEventFamilyProblems({ kinds: ['alarm-triggered'], deviceIds: [102] })).toEqual([])
  })
  it('refuses a missing condition', () => {
    expect(systemEventFamilyProblems(undefined)).toEqual([{ code: 'no-kinds' }])
  })
  it('refuses kinds spanning families, naming them', () => {
    expect(systemEventFamilyProblems({ kinds: ['device-offline', 'node-offline'] })).toEqual([
      { code: 'mixed-families', families: ['device-events', 'system'] },
    ])
  })
  it('refuses a legacy kind by name', () => {
    expect(systemEventFamilyProblems({ kinds: ['camera-offline'] })).toEqual([
      { code: 'legacy-kind', kind: 'camera-offline' },
    ])
  })
  it('refuses every out-of-family filter by name', () => {
    expect(
      systemEventFamilyProblems({
        kinds: ['export-completed'],
        deviceIds: [102],
        nodeIds: ['hub'],
      }),
    ).toEqual([{ code: 'filter-outside-family', filter: 'deviceIds', family: 'system' }])
    expect(systemEventFamilyProblems({ kinds: ['alarm-armed'], excludeDeviceIds: [1] })).toEqual([
      { code: 'filter-outside-family', filter: 'excludeDeviceIds', family: 'alarm' },
    ])
  })
  it('describes a problem in words that name the offender', () => {
    expect(
      describeSystemEventFamilyProblem({
        code: 'filter-outside-family',
        filter: 'deviceIds',
        family: 'system',
      }),
    ).toMatch(/deviceIds.*system/)
    expect(
      describeSystemEventFamilyProblem({
        code: 'mixed-families',
        families: ['device-events', 'alarm'],
      }),
    ).toMatch(/device-events.*alarm/)
  })
})
