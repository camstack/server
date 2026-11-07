/**
 * A stableId is unique per ADDON, not per cluster: two integrations can each
 * own a device called `sensor-1`. A `global` expression binding therefore names
 * the owning addon too, and the mirror resolves the pair — a bare stableId that
 * two devices share resolves to NEITHER (unknown, never the wrong device).
 */
import { describe, expect, it } from 'vitest'
import { ConditionMirror, collectWhenMirrorSources, stableIdKey } from '../condition-eval.js'
import type { AutomationWhen } from '../when.js'

const when = (addonId: string | undefined): AutomationWhen => ({
  kind: 'expression',
  expr: 'x > 1',
  bindings: {
    x: {
      kind: 'global',
      sourceStableId: 'sensor-1',
      ...(addonId !== undefined ? { addonId } : {}),
      cap: 'sensor',
      fieldPath: 'value',
    },
  },
})

const fetchers = {
  fetchSlice: async (deviceId: number) => ({ value: deviceId * 10 }),
  // what the hub hands the mirror: the pair key always, the bare key only when unique
  fetchStableIds: async () =>
    new Map<string, number>([
      [stableIdKey('sensor-1', 'addon-a'), 1],
      [stableIdKey('sensor-1', 'addon-b'), 2],
    ]),
}

describe('mirror stableId collision', () => {
  it('carries the addon on the mirror source', () => {
    expect(collectWhenMirrorSources(when('addon-b'))).toEqual([
      { kind: 'stable', stableId: 'sensor-1', addonId: 'addon-b', cap: 'sensor' },
    ])
  })

  it('reads the device of the named addon, not the first stableId match', async () => {
    const m = new ConditionMirror(collectWhenMirrorSources(when('addon-b')))
    await m.refresh(fetchers)
    expect(m.readStable('sensor-1', 'sensor', 'value', 'addon-b')).toBe(20)
    const a = new ConditionMirror(collectWhenMirrorSources(when('addon-a')))
    await a.refresh(fetchers)
    expect(a.readStable('sensor-1', 'sensor', 'value', 'addon-a')).toBe(10)
  })

  it('a legacy binding with no addon and a shared stableId reads nothing', async () => {
    const m = new ConditionMirror(collectWhenMirrorSources(when(undefined)))
    await m.refresh(fetchers)
    expect(m.readStable('sensor-1', 'sensor', 'value')).toBeUndefined()
  })
})
