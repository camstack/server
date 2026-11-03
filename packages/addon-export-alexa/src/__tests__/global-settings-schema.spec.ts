import { describe, expect, it } from 'vitest'
import { buildAlexaInstanceSections } from '../settings-schema.js'
import { ALEXA_SKILL_DEFAULT_BODY } from '../skill-records.js'

/**
 * The skill region picks the Event Gateway for EVERY proactive post — doorbell,
 * motion, online/offline and the discovery Add/DeleteReports (`lwa-event-gateway.ts`,
 * `postEventBody`). Its help text named only the doorbell, which sent operators
 * looking elsewhere when motion and new cameras never reached Alexa.
 */
describe('export-alexa skill form', () => {
  it('says the skill region governs every event the hub pushes, not just the doorbell', () => {
    const field = buildAlexaInstanceSections({ defaults: ALEXA_SKILL_DEFAULT_BODY })
      .flatMap((s) => s.fields)
      .find((f) => 'key' in f && f.key === 'region')
    const description = field && 'description' in field ? String(field.description) : ''
    for (const kind of [/doorbell/i, /motion/i, /offline/i, /device-list/i]) {
      expect(description).toMatch(kind)
    }
  })
})
