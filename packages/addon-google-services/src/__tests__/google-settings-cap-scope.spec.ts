/**
 * Google broker setup copy.
 */
import { describe, expect, it } from 'vitest'

import {
  buildGoogleBrokerSettingsSchema,
  googleBrokerSetupHtml,
} from '../google-broker-settings-schema.js'
import { connectHtml, introHtml } from '../google-settings-copy.js'

describe('google broker Setup HTML', () => {
  it('mentions Audience / Test users and Test connection', () => {
    const html = googleBrokerSetupHtml('https://hub.example')
    expect(html).toMatch(/Audience/i)
    expect(html).toMatch(/Test users|access_denied/i)
    expect(html).toMatch(/Test connection/i)
    expect(html).toMatch(/Sign in/i)
    expect(html).toContain('https://hub.example/addon/google-services/oauth/callback')
  })

  it('broker schema includes setup-intro + oauth client (no Connect link field)', () => {
    const schema = buildGoogleBrokerSettingsSchema('https://hub.example')
    expect(schema.sections.map((s) => s.id)).toEqual(
      expect.arrayContaining(['setup-intro', 'google-oauth-client', 'gmail-send']),
    )
    expect(schema.sections.map((s) => s.id)).not.toContain('google-calendar')
    expect(schema.sections.map((s) => s.id)).not.toContain('google-calendars-import')
    const keys = schema.sections.flatMap((s) =>
      s.fields.map((f) => ('key' in f ? f.key : undefined)),
    )
    expect(keys).not.toContain('_connectInfo')
  })
})

describe('google-settings-copy', () => {
  it('intro lists steps and names the redirect URI', () => {
    const html = introHtml('calendar-source', 'https://hub.example')
    expect(html).toContain('<ol>')
    expect(html).toContain('https://hub.example/addon/google-services/oauth/callback')
    expect(html).toContain('/addon/google-services/oauth/start')
  })

  it('Connect keeps a same-origin relative start link', () => {
    const html = connectHtml('smtp-provider', 'https://hub.example')
    expect(html).toContain('href="/addon/google-services/oauth/start"')
    expect(html).not.toContain('href="https://hub.example/addon/')
  })

  it('intro links to Google Cloud Console', () => {
    const html = introHtml('calendar-source', 'https://hub.example')
    expect(html).toContain('https://console.cloud.google.com/apis/library')
    expect(html).toContain('https://console.cloud.google.com/apis/credentials')
  })
})
