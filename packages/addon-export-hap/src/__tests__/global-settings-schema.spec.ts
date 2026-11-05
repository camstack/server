import { describe, expect, it } from 'vitest'
import type { ConfigUISchema } from '@camstack/types'
import { ExportHapAddon } from '../hap-export.addon.js'

/**
 * The settings forms offer only what the addon reads. A HAP port field sat here for months while
 * every accessory and the bridge were published on an ephemeral port (`port: 0`) regardless —
 * and one fixed port could not serve a fleet of standalone cameras anyway, each of which needs
 * its own. D986: the node form and the device defaults are the editable surfaces.
 */
const CAP = 'device-export'

async function keysOf(addon: ExportHapAddon): Promise<readonly string[]> {
  const schemas: ConfigUISchema[] = []
  for (const scope of ['cluster', 'node', 'device-defaults'] as const) {
    const schema = await addon.getScopedSettingsSchema(scope, CAP)
    if (schema) schemas.push(schema)
  }
  return schemas.flatMap((schema) =>
    schema.sections.flatMap((s) => s.fields.map((f) => ('key' in f ? String(f.key) : ''))),
  )
}

describe('export-hap settings', () => {
  it('offers no HAP port — nothing reads one', async () => {
    expect(await keysOf(new ExportHapAddon())).not.toContain('port')
  })

  it('offers no PTZ pulse duration — the driver owns it as `moveImpulseMs`', async () => {
    // A HomeKit direction switch issues one `ptz.move`, which self-terminates
    // after the duration the PTZ driver calibrated and reports through
    // `ptz.getOptions().moveImpulseMs`. A second, exporter-owned duration
    // would be a second authority over the same pulse.
    expect(await keysOf(new ExportHapAddon())).not.toContain('ptzPulseMs')
  })

  it('keeps the node-scoped interface name and the fleet clip retention, and no cluster key', async () => {
    const addon = new ExportHapAddon()
    expect(await addon.getScopedSettingsSchema('cluster', CAP)).toBeNull()
    expect(await keysOf(addon)).toEqual(['interfaceName', 'clipRetentionDays'])
  })
})

class Probe extends ExportHapAddon {
  override scopedSettingsCapabilities(): readonly string[] {
    return super.scopedSettingsCapabilities()
  }
}

describe('export-hap node settings at boot', () => {
  it('names the capability of its node schema, so interfaceName resolves per node at the first resolve', () => {
    expect(new Probe().scopedSettingsCapabilities()).toContain(CAP)
  })
})
