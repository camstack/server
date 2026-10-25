import { describe, expect, it } from 'vitest'
import { substituteBrokerIdPlaceholders } from '../broker-form-placeholders.js'
import type { ConfigUISchema } from '../../../types/config-ui'

describe('substituteBrokerIdPlaceholders', () => {
  it('replaces {{brokerId}} in info field HTML', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'oauth',
          title: 'OAuth',
          columns: 1,
          fields: [
            {
              type: 'info',
              key: '_connect',
              label: 'Connect',
              format: 'html',
              content: 'Open <a href="/oauth/start?brokerId={{brokerId}}">Connect</a>',
            },
          ],
        },
      ],
    }
    const out = substituteBrokerIdPlaceholders(schema, 'google_001')
    const field = out.sections[0]!.fields[0]!
    expect(field.type).toBe('info')
    if (field.type === 'info') {
      expect(field.content).toBe('Open <a href="/oauth/start?brokerId=google_001">Connect</a>')
      expect(field.content).not.toContain('{{brokerId}}')
    }
  })
})
