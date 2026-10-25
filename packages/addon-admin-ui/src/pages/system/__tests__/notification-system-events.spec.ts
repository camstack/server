/**
 * The SYSTEM-EVENT vocabulary and value logic.
 *
 * The properties under test are the ones an operator pays for when they break:
 * the kind list must be the SCHEMA's list (a ninth kind server-side must fail
 * here, not render as seven of eight), a filter must never survive the kinds
 * that made it meaningful, and the last kind can never be cleared — a rule
 * with no kinds is `mixed` (D637), and the hub rejects `{ kinds: [] }`.
 */
import {
  NC_ALARM_SYSTEM_EVENT_KINDS,
  NC_AUTHORABLE_SYSTEM_EVENT_KINDS,
  NC_SYSTEM_EVENT_FAMILIES,
  NC_SYSTEM_EVENT_KIND_GROUP_SPECS,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'

import {
  batteryKindsNarrowedByType,
  NC_SYSTEM_EVENT_KIND_GROUPS,
  NC_SYSTEM_EVENT_KIND_OPTIONS,
  parseSystemEventKind,
  patchSystemEventFilters,
  pruneSystemEventForSave,
  seedSystemEventForFamily,
  summariseSystemEventKinds,
  summariseSystemEventScope,
  systemEventFilterVisibility,
  systemEventFilterVisibilityFor,
  systemEventKindGroupsFor,
  systemEventKindLabel,
  toggleSystemEventKind,
} from '../notification-system-events'

describe('D637 — the field authors ONE family', () => {
  it('offers only the family’s groups', () => {
    expect(systemEventKindGroupsFor('alarm').flatMap((g) => g.kinds.map((k) => k.value))).toEqual([
      ...NC_ALARM_SYSTEM_EVENT_KINDS,
    ])
    expect(systemEventKindGroupsFor('system').map((g) => g.id)).toEqual([
      'nodes',
      'addons',
      'addon-updates',
      'updates',
      'backups-exports',
      'storage',
      'alerts',
      'rule-health',
    ])
    // D708: every group has its own hint — the new `addon-updates` included.
    for (const group of systemEventKindGroupsFor('system'))
      expect(group.hint, group.id).not.toBe('')
    expect(systemEventKindGroupsFor('device-events').map((g) => g.id)).toEqual([
      'device-state',
      'streams',
      'battery',
      'consumables',
      'detection-blind',
      'motion-noise',
      'recording',
      'device-attention',
    ])
  })

  it('builds its groups from the shared specs, each with a hint', () => {
    expect(NC_SYSTEM_EVENT_KIND_GROUPS.map((g) => [g.id, g.family])).toEqual(
      NC_SYSTEM_EVENT_KIND_GROUP_SPECS.map((g) => [g.id, g.family]),
    )
    for (const group of NC_SYSTEM_EVENT_KIND_GROUPS) {
      expect(group.hint.length, group.id).toBeGreaterThan(0)
    }
  })

  it('never shows a device picker on a system rule, and never a node picker on a device rule', () => {
    expect(systemEventFilterVisibilityFor('system', ['node-offline', 'addon-updated'])).toEqual({
      devices: false,
      excludeDevices: false,
      deviceTypes: false,
      nodes: true,
      packages: true,
      consumableThreshold: false,
    })
    expect(systemEventFilterVisibilityFor('device-events', ['device-offline']).nodes).toBe(false)
    expect(systemEventFilterVisibilityFor('device-events', ['device-offline'])).toEqual({
      devices: true,
      excludeDevices: true,
      deviceTypes: true,
      nodes: false,
      packages: false,
      consumableThreshold: false,
    })
  })

  it('alarm: the camera filter appears only with alarm-triggered', () => {
    expect(systemEventFilterVisibilityFor('alarm', ['alarm-armed']).devices).toBe(false)
    expect(
      systemEventFilterVisibilityFor('alarm', ['alarm-armed', 'alarm-triggered']).devices,
    ).toBe(true)
    expect(systemEventFilterVisibilityFor('alarm', ['alarm-triggered']).excludeDevices).toBe(false)
  })

  it('refuses to untick the last kind (the family would flip)', () => {
    const one = { kinds: ['node-offline' as const] }
    expect(toggleSystemEventKind(one, 'node-offline', 'system')).toBe(one)
  })

  it('refuses to add a kind of another family', () => {
    const one = { kinds: ['node-offline' as const] }
    expect(toggleSystemEventKind(one, 'device-offline', 'system')).toBe(one)
  })

  it('prunes out-of-family filters on save, and the alarm camera filter without alarm-triggered', () => {
    expect(pruneSystemEventForSave('alarm', { kinds: ['alarm-armed'], deviceIds: [102] })).toEqual({
      kinds: ['alarm-armed'],
    })
    expect(
      pruneSystemEventForSave('alarm', { kinds: ['alarm-triggered'], deviceIds: [102] }),
    ).toEqual({ kinds: ['alarm-triggered'], deviceIds: [102] })
    expect(
      pruneSystemEventForSave('system', { kinds: ['export-completed'], deviceIds: [102] }),
    ).toEqual({ kinds: ['export-completed'] })
    expect(
      pruneSystemEventForSave('alarm', { kinds: ['alarm-triggered'], excludeDeviceIds: [1] }),
    ).toEqual({ kinds: ['alarm-triggered'] })
    expect(pruneSystemEventForSave('system', undefined)).toBeUndefined()
  })

  it('seeds every family with kinds OF that family — never an empty (mixed) rule', () => {
    for (const family of NC_SYSTEM_EVENT_FAMILIES) {
      const seed = seedSystemEventForFamily(family)
      expect(seed.kinds.length, family).toBeGreaterThan(0)
      const offered = systemEventKindGroupsFor(family).flatMap((g) => g.kinds.map((k) => k.value))
      for (const kind of seed.kinds) expect(offered, family).toContain(kind)
    }
  })
})

describe('the kind vocabulary', () => {
  it('offers EXACTLY the AUTHORABLE kinds — no more, no fewer', () => {
    // The schema also carries the legacy camera-worded tail, kept only so a
    // durable row and an unmigrated rule still parse. Offering one would let
    // an operator author a rule that can never fire.
    expect(NC_SYSTEM_EVENT_KIND_OPTIONS.map((o) => o.value).toSorted()).toEqual(
      [...NC_AUTHORABLE_SYSTEM_EVENT_KINDS].toSorted(),
    )
  })

  it('offers every alarm transition, in the lifecycle order the hub lists them', () => {
    // The four once held back (pending, rearmed, sensor-bypass, check-failed)
    // have a producer since the alarm revamp (D630).
    const alarm = NC_SYSTEM_EVENT_KIND_GROUPS.find((g) => g.id === 'alarm')
    expect(alarm?.kinds.map((k) => k.value)).toEqual([...NC_ALARM_SYSTEM_EVENT_KINDS])
  })

  it('reaches every offered kind through a group, each exactly once', () => {
    const grouped = NC_SYSTEM_EVENT_KIND_GROUPS.flatMap((g) => g.kinds.map((k) => k.value))
    expect(grouped.toSorted()).toEqual([...NC_AUTHORABLE_SYSTEM_EVENT_KINDS].toSorted())
    expect(new Set(grouped).size).toBe(grouped.length)
  })

  it('labels match the viewer word for word (one feature, one name)', () => {
    expect(systemEventKindLabel('alarm-triggered')).toBe('Alarm triggered')
    expect(systemEventKindLabel('wrapper-update-available')).toBe(
      'Container / app update available',
    )
    expect(systemEventKindLabel('device-offline')).toBe('Device offline')
    expect(systemEventKindLabel('stream-online')).toBe('Stream online')
    expect(systemEventKindLabel('node-offline')).toBe('Node offline')
    expect(systemEventKindLabel('addon-update-available')).toBe('Addon update available')
    expect(systemEventKindLabel('server-update-available')).toBe('Server update available')
    expect(systemEventKindLabel('addon-updated')).toBe('Addons updated')
    expect(systemEventKindLabel('server-updated')).toBe('Server updated')
    expect(systemEventKindLabel('node-restarting')).toBe('Node restarting')
    expect(systemEventKindLabel('node-updating')).toBe('Node updating (restart imminent)')
    expect(systemEventKindLabel('export-completed')).toBe('Export completed')
  })

  it('falls back to the raw value for a kind this build does not know', () => {
    expect(systemEventKindLabel('disk-full')).toBe('disk-full')
  })

  it('narrows a known kind and rejects an unknown one (no cast)', () => {
    expect(parseSystemEventKind('node-online')).toBe('node-online')
    expect(parseSystemEventKind('nope')).toBeUndefined()
  })
})

describe('systemEventFilterVisibility', () => {
  it('shows only the filters the selected kinds can narrow', () => {
    expect(systemEventFilterVisibility(['device-offline'])).toEqual({
      devices: true,
      deviceTypes: true,
      nodes: false,
      packages: false,
      consumableThreshold: false,
    })
    // A stream belongs to a camera by construction — no type to narrow.
    expect(systemEventFilterVisibility(['stream-offline'])).toEqual({
      devices: true,
      deviceTypes: false,
      nodes: false,
      packages: false,
      consumableThreshold: false,
    })
    expect(systemEventFilterVisibility(['node-offline'])).toEqual({
      devices: false,
      deviceTypes: false,
      nodes: true,
      packages: false,
      consumableThreshold: false,
    })
    // An addon update is reported per node AND per package.
    expect(systemEventFilterVisibility(['addon-update-available'])).toEqual({
      devices: false,
      deviceTypes: false,
      nodes: true,
      packages: true,
      consumableThreshold: false,
    })
    expect(systemEventFilterVisibility(['server-update-available'])).toEqual({
      devices: false,
      deviceTypes: false,
      nodes: true,
      packages: true,
      consumableThreshold: false,
    })
    expect(systemEventFilterVisibility(['export-completed'])).toEqual({
      devices: false,
      deviceTypes: false,
      nodes: false,
      packages: false,
      consumableThreshold: false,
    })
    expect(systemEventFilterVisibility(['addon-updated'])).toEqual({
      devices: false,
      deviceTypes: false,
      nodes: true,
      packages: true,
      consumableThreshold: false,
    })
  })

  it('is the union across kinds', () => {
    expect(systemEventFilterVisibility(['stream-offline', 'server-update-available'])).toEqual({
      devices: true,
      deviceTypes: false,
      nodes: true,
      packages: true,
      consumableThreshold: false,
    })
  })
})

describe('toggleSystemEventKind', () => {
  it('adds a kind to an absent condition', () => {
    expect(toggleSystemEventKind(undefined, 'device-offline', 'device-events')).toEqual({
      kinds: ['device-offline'],
    })
  })

  it('keeps kinds in authoring order however they were clicked', () => {
    const one = toggleSystemEventKind(undefined, 'node-online', 'system')
    const two = toggleSystemEventKind(one, 'node-offline', 'system')
    expect(two?.kinds).toEqual(['node-offline', 'node-online'])
  })

  it('never removes the last kind — never `{ kinds: [] }`, never a family flip', () => {
    // `kinds` is `.min(1)` server-side, and a rule with no kinds is `mixed`
    // (D637): it would stop being the family the operator is editing.
    const value = { kinds: ['device-offline' as const] }
    expect(toggleSystemEventKind(value, 'device-offline', 'device-events')).toBe(value)
  })

  it('drops a filter whose kinds are gone', () => {
    // The camera list stops being rendered the moment `alarm-triggered` is
    // deselected. Keeping it would leave an invisible restriction on the rule.
    const before = { kinds: ['alarm-armed', 'alarm-triggered'] as const, deviceIds: [101] }
    const after = toggleSystemEventKind(
      { ...before, kinds: [...before.kinds] },
      'alarm-triggered',
      'alarm',
    )
    expect(after).toEqual({ kinds: ['alarm-armed'] })
  })

  it('keeps a filter that the remaining kinds still use', () => {
    const after = toggleSystemEventKind(
      { kinds: ['device-offline', 'device-online'], deviceIds: [101] },
      'device-online',
      'device-events',
    )
    expect(after).toEqual({ kinds: ['device-offline'], deviceIds: [101] })
  })
})

describe('patchSystemEventFilters', () => {
  it('writes a non-empty filter', () => {
    expect(patchSystemEventFilters({ kinds: ['node-offline'] }, { nodeIds: ['agent-a'] })).toEqual({
      kinds: ['node-offline'],
      nodeIds: ['agent-a'],
    })
  })

  it('clears a filter by OMITTING it — `[]` would match nothing', () => {
    expect(
      patchSystemEventFilters({ kinds: ['node-offline'], nodeIds: ['agent-a'] }, { nodeIds: [] }),
    ).toEqual({ kinds: ['node-offline'] })
  })

  it('leaves the filters it was not asked about alone', () => {
    expect(
      patchSystemEventFilters(
        { kinds: ['device-offline', 'addon-update-available'], deviceIds: [101] },
        { packageNames: ['@camstack/addon-ai'] },
      ),
    ).toEqual({
      kinds: ['device-offline', 'addon-update-available'],
      deviceIds: [101],
      packageNames: ['@camstack/addon-ai'],
    })
  })

  it('refuses to author a filter with no kind gate', () => {
    expect(patchSystemEventFilters(undefined, { nodeIds: ['agent-a'] })).toBeUndefined()
  })
})

describe('list summaries', () => {
  it('names the leading kinds and counts the rest', () => {
    expect(
      summariseSystemEventKinds(['device-offline', 'device-online', 'node-offline', 'node-online']),
    ).toBe('Device offline, Device online +2')
    expect(summariseSystemEventKinds(['node-offline'])).toBe('Node offline')
  })

  it('says so when a rule selects nothing', () => {
    expect(summariseSystemEventKinds(undefined)).toBe('No event selected')
    expect(summariseSystemEventKinds([])).toBe('No event selected')
  })

  it('states an unnarrowed rule as "Everything", not as blank', () => {
    expect(summariseSystemEventScope({ kinds: ['device-offline'] })).toBe('Everything')
  })

  it('counts each narrowing filter', () => {
    expect(
      summariseSystemEventScope({
        kinds: ['device-offline', 'node-offline', 'addon-update-available'],
        deviceIds: [101, 102],
        nodeIds: ['agent-a'],
        packageNames: ['@camstack/addon-ai'],
      }),
    ).toBe('2 devices · 1 node · 1 package')
  })
})

/**
 * D636 — the exclude list, and the warning that would have caught the live
 * outage: "Eventi di sistema" carried the battery and consumable kinds under
 * `deviceTypes: ['camera']`, and every battery on the hub belongs to a sensor,
 * a container or a vacuum.
 */
describe('excludeDeviceIds', () => {
  const BATTERY = { kinds: ['device-battery-low' as const] }

  it('is patched like the other filters — an emptied list is ABSENT', () => {
    const excluded = patchSystemEventFilters(BATTERY, { excludeDeviceIds: [3615] })
    expect(excluded).toEqual({ kinds: ['device-battery-low'], excludeDeviceIds: [3615] })
    expect(patchSystemEventFilters(excluded, { excludeDeviceIds: [] })).toEqual(BATTERY)
  })

  it('survives a kind change that keeps a device kind, and never rides into another family', () => {
    const value = { kinds: ['device-battery-low' as const], excludeDeviceIds: [3615] }
    const widened = toggleSystemEventKind(value, 'device-offline', 'device-events')
    expect(widened?.excludeDeviceIds).toEqual([3615])
    const narrowed = toggleSystemEventKind(widened, 'device-battery-low', 'device-events')
    expect(narrowed).toEqual({ kinds: ['device-offline'], excludeDeviceIds: [3615] })
    // Only a device-events rule carries an exclude list.
    expect(
      pruneSystemEventForSave('system', { kinds: ['node-offline'], excludeDeviceIds: [3615] }),
    ).toEqual({ kinds: ['node-offline'] })
  })

  it('is named in the scope summary', () => {
    expect(summariseSystemEventScope({ ...BATTERY, excludeDeviceIds: [1, 2] })).toBe(
      'Everything except 2 devices',
    )
    expect(summariseSystemEventScope({ ...BATTERY, deviceIds: [5], excludeDeviceIds: [1] })).toBe(
      '1 device · except 1 device',
    )
  })
})

describe('batteryKindsNarrowedByType — the warning', () => {
  it('warns when a battery or consumable kind meets a device-type filter', () => {
    expect(
      batteryKindsNarrowedByType({
        kinds: ['device-offline', 'device-battery-low'],
        deviceTypes: ['camera'],
      }),
    ).toBe(true)
    expect(
      batteryKindsNarrowedByType({ kinds: ['device-consumable-low'], deviceTypes: ['vacuum'] }),
    ).toBe(true)
  })

  it('is silent without a type filter, or without a battery/consumable kind', () => {
    expect(batteryKindsNarrowedByType({ kinds: ['device-battery-low'] })).toBe(false)
    expect(batteryKindsNarrowedByType({ kinds: ['device-offline'], deviceTypes: ['camera'] })).toBe(
      false,
    )
    expect(batteryKindsNarrowedByType(undefined)).toBe(false)
  })
})
