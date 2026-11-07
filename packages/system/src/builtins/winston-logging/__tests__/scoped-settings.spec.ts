import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { WinstonLoggingAddon } from '../winston-logging.addon.js'

/**
 * D986: winston logging keeps its files per node, so it declares the level and the retention on
 * the NODE hook of `log-destination`, names that capability up front (the first config resolve
 * runs before the providers register), marks both fields `perNode` (the node page draws only
 * those) and declares nothing on the cluster hook.
 */
class Probe extends WinstonLoggingAddon {
  caps(): readonly string[] {
    return this.scopedSettingsCapabilities()
  }
}

function fieldsOf(schema: ConfigUISchema | null) {
  if (schema === null) throw new Error('no schema declared')
  return schema.sections
    .flatMap((section) => section.fields)
    .flatMap((field) => ('key' in field && field.type !== 'info' ? [field] : []))
}

describe('winston logging scoped settings', () => {
  it('declares level and retentionDays on the node hook only, both per node', async () => {
    const addon = new Probe()
    expect(addon.caps()).toContain('log-destination')
    const node = fieldsOf(await addon.getScopedSettingsSchema('node', 'log-destination'))
    expect(node.map((field) => field.key).sort()).toEqual(['level', 'retentionDays'])
    expect(node.every((field) => 'perNode' in field && field.perNode === true)).toBe(true)
    expect(await addon.getScopedSettingsSchema('cluster', 'log-destination')).toBeNull()
    expect(await addon.getScopedSettingsSchema('node', 'not-a-capability')).toBeNull()
  })
})
