import { describe, expect, it } from 'vitest'
import type { ConfigUISchema } from '@camstack/types'
import { ExportAlexaAddon } from '../export-alexa.addon.js'

/**
 * The skill region picks the Event Gateway for EVERY proactive post — doorbell,
 * motion, online/offline and the discovery Add/DeleteReports (`lwa-event-gateway.ts`,
 * `postEventBody`). Its help text named only the doorbell, which sent operators
 * looking elsewhere when motion and new cameras never reached Alexa.
 */
function schemaOf(addon: ExportAlexaAddon): ConfigUISchema {
  const read = (addon as unknown as { globalSettingsSchema: () => ConfigUISchema | null })
    .globalSettingsSchema
  const schema = read.call(addon)
  if (!schema) throw new Error('export-alexa: no global settings schema')
  return schema
}

describe('export-alexa global settings', () => {
  it('says the skill region governs every event the hub pushes, not just the doorbell', () => {
    const field = schemaOf(new ExportAlexaAddon())
      .sections.flatMap((s) => s.fields)
      .find((f) => 'key' in f && f.key === 'region')
    const description = field && 'description' in field ? String(field.description) : ''
    for (const kind of [/doorbell/i, /motion/i, /offline/i, /device-list/i]) {
      expect(description).toMatch(kind)
    }
  })
})
