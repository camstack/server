/**
 * D986 scoped settings: the declaration hooks, the node-id parse and the fleet-default
 * resolution order with its source per field.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import { BaseAddon } from '../base-addon.js'
import { nodeIdOfScopedKey, resolveDeviceSettings, resolvedValues } from '../scoped-settings.js'

const schemaOf = (key: string): ConfigUISchema => ({
  sections: [{ id: key, title: key, fields: [{ type: 'text', key, label: key }] }],
})

class Scoped extends BaseAddon<Record<string, never>> {
  constructor() {
    super({})
  }
  protected override async onInitialize() {
    return []
  }
  protected override async clusterSettingsSchema(cap: string) {
    return cap === 'detector' ? schemaOf('clusterKey') : null
  }
  protected override async nodeSettingsSchema(cap: string) {
    return cap === 'detector' ? schemaOf('nodeKey') : null
  }
  protected override async deviceDefaultsSchema(cap: string) {
    return cap === 'detector' ? schemaOf('defaultKey') : null
  }
}

class Plain extends BaseAddon<Record<string, never>> {
  constructor() {
    super({})
  }
  protected override async onInitialize() {
    return []
  }
}

describe('BaseAddon.getScopedSettingsSchema', () => {
  it('answers each scope with the schema its own hook declares, per capability', async () => {
    const addon = new Scoped()
    const keyOf = (s: ConfigUISchema | null): string | null => {
      const field = s?.sections[0]?.fields[0]
      return field !== undefined && 'key' in field ? field.key : null
    }
    expect(keyOf(await addon.getScopedSettingsSchema('cluster', 'detector'))).toBe('clusterKey')
    expect(keyOf(await addon.getScopedSettingsSchema('node', 'detector'))).toBe('nodeKey')
    expect(keyOf(await addon.getScopedSettingsSchema('device-defaults', 'detector'))).toBe(
      'defaultKey',
    )
    expect(await addon.getScopedSettingsSchema('cluster', 'other')).toBeNull()
  })

  it('declares nothing by default', async () => {
    const addon = new Plain()
    for (const scope of ['cluster', 'node', 'device-defaults'] as const) {
      expect(await addon.getScopedSettingsSchema(scope, 'detector')).toBeNull()
    }
    expect(vi.isMockFunction(addon.getScopedSettingsSchema)).toBe(false)
  })
})

describe('nodeIdOfScopedKey', () => {
  it('takes the node id after the @, and nothing for a key without one', () => {
    expect(nodeIdOfScopedKey('backend@agent-1')).toBe('agent-1')
    expect(nodeIdOfScopedKey('backend')).toBeNull()
    expect(nodeIdOfScopedKey('backend@')).toBeNull()
    expect(nodeIdOfScopedKey('@agent-1')).toBeNull()
  })
})

describe('resolveDeviceSettings', () => {
  const layers = {
    schemaDefaults: { a: 'schema-a', b: 'schema-b', c: 'schema-c', d: 'schema-d' },
    fleetDefaults: { b: 'fleet-b', c: 'fleet-c', 'x@node-1': 'node-row', stray: 'fleet-stray' },
    deviceOverrides: { c: 'device-c', d: null },
  }

  it('gives device, then fleet default, then schema default, with the source per field', () => {
    expect(resolveDeviceSettings(layers)).toEqual({
      a: { value: 'schema-a', source: 'schema-default' },
      b: { value: 'fleet-b', source: 'fleet-default' },
      c: { value: 'device-c', source: 'device' },
      d: { value: null, source: 'device' },
    })
  })

  it('keeps an override equal to the default as an override, and an undefined layer value absent', () => {
    const r = resolveDeviceSettings({
      schemaDefaults: { a: 1 },
      fleetDefaults: { a: undefined },
      deviceOverrides: { a: 1 },
    })
    expect(r['a']).toEqual({ value: 1, source: 'device' })
    const r2 = resolveDeviceSettings({
      schemaDefaults: { a: 1 },
      fleetDefaults: { a: undefined },
      deviceOverrides: {},
    })
    expect(r2['a']).toEqual({ value: 1, source: 'schema-default' })
  })

  it('never lets a node row or a field outside the schema become a fleet default', () => {
    const r = resolveDeviceSettings(layers)
    expect('x@node-1' in r).toBe(false)
    expect('stray' in r).toBe(false)
  })

  it('resolvedValues drops the source', () => {
    expect(resolvedValues(resolveDeviceSettings(layers))).toEqual({
      a: 'schema-a',
      b: 'fleet-b',
      c: 'device-c',
      d: null,
    })
  })
})
