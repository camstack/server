/**
 * Connectivity Calendars / Email point at Brokers (no duplicate OAuth fields).
 */
import { describe, expect, it } from 'vitest'

import { GoogleServicesAddon } from '../google-services.addon.js'
import {
  buildGoogleBrokerSettingsSchema,
  googleBrokerSetupHtml,
} from '../google-broker-settings-schema.js'
import { connectHtml, introHtml } from '../google-settings-copy.js'

type SchemaReader = {
  globalSettingsSchema(cap?: string): {
    sections: Array<{ id: string; fields: Array<{ key?: string; content?: string }> }>
  } | null
}

function sectionIds(cap?: string): readonly string[] {
  const addon = new GoogleServicesAddon() as unknown as SchemaReader
  return (addon.globalSettingsSchema(cap)?.sections ?? []).map((s) => s.id)
}

function fieldContent(cap: string | undefined, sectionId: string, key: string): string {
  const addon = new GoogleServicesAddon() as unknown as SchemaReader
  const section = addon.globalSettingsSchema(cap)?.sections.find((s) => s.id === sectionId)
  const field = section?.fields.find((f) => f.key === key)
  return field?.content ?? ''
}

describe('GoogleServicesAddon settings scoped by capability', () => {
  it('calendar-source: Brokers pointer + calendars import multiselect', () => {
    expect(sectionIds('calendar-source')).toEqual(['setup-intro', 'google-calendars-import'])
    const html = fieldContent('calendar-source', 'setup-intro', '_setupSteps')
    expect(html).toContain('Brokers')
  })

  it('smtp-provider: only setup pointer to Brokers', () => {
    expect(sectionIds('smtp-provider')).toEqual(['setup-intro'])
    const html = fieldContent('smtp-provider', 'setup-intro', '_setupSteps')
    expect(html).toContain('Brokers')
    expect(html).toMatch(/Gmail|From/i)
  })

  it('addon page (no cap) still only points at Brokers', () => {
    expect(sectionIds()).toEqual(['setup-intro'])
  })

  it('does not ship a gmailSendEnabled switch', () => {
    const addon = new GoogleServicesAddon() as unknown as SchemaReader
    const keys = (addon.globalSettingsSchema('smtp-provider')?.sections ?? []).flatMap((s) =>
      s.fields.map((f) => f.key),
    )
    expect(keys).not.toContain('gmailSendEnabled')
  })
})

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
