import { describe, expect, it } from 'vitest'
import type { ConfigUISchema } from '@camstack/types'
import { ExportHapAddon } from '../hap-export.addon.js'

/**
 * The global settings form offers only what the addon reads. A HAP port field
 * sat here for months while every accessory and the bridge were published on an
 * ephemeral port (`port: 0`) regardless — and one fixed port could not serve a
 * fleet of standalone cameras anyway, each of which needs its own.
 */
function schemaOf(addon: ExportHapAddon): ConfigUISchema {
  const read = (addon as unknown as { globalSettingsSchema: () => ConfigUISchema | null })
    .globalSettingsSchema
  const schema = read.call(addon)
  if (!schema) throw new Error('export-hap: no global settings schema')
  return schema
}

function fieldKeys(schema: ConfigUISchema): readonly string[] {
  return schema.sections.flatMap((s) => s.fields.map((f) => ('key' in f ? String(f.key) : '')))
}

describe('export-hap global settings', () => {
  it('offers no HAP port — nothing reads one', () => {
    expect(fieldKeys(schemaOf(new ExportHapAddon()))).not.toContain('port')
  })

  it('offers no PTZ pulse duration — the driver owns it as `moveImpulseMs`', () => {
    // A HomeKit direction switch issues one `ptz.move`, which self-terminates
    // after the duration the PTZ driver calibrated and reports through
    // `ptz.getOptions().moveImpulseMs`. A second, exporter-owned duration
    // would be a second authority over the same pulse.
    expect(fieldKeys(schemaOf(new ExportHapAddon()))).not.toContain('ptzPulseMs')
  })

  it('keeps only the node-scoped interface name: the bridge knobs left the global form', () => {
    expect(fieldKeys(schemaOf(new ExportHapAddon()))).toEqual(['interfaceName'])
  })
})
