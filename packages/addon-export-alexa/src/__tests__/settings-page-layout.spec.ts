/**
 * The exporter settings page pattern: Connection / Features / Account link /
 * one collapsed Troubleshooting section, every action an `addon-action-button`
 * that reports its outcome, and rows that belong to the custom skill gated by
 * `showWhen` on `skillMode` — so the form reacts the moment the operator
 * switches mode, and a section whose rows are all hidden is not drawn.
 */
import { describe, expect, it } from 'vitest'
import type { ConfigField, ConfigSection, ConfigUISchema } from '@camstack/types'
import { exportAlexaActions } from '../custom-actions.js'
import { ExportAlexaAddon } from '../export-alexa.addon.js'

type Mode = 'public' | 'custom'

function schemaFor(mode: Mode): ConfigUISchema {
  const addon = new ExportAlexaAddon()
  const internals = addon as unknown as {
    _config: Record<string, unknown>
    globalSettingsSchema: () => ConfigUISchema | null
  }
  internals._config = { ...internals._config, skillMode: mode }
  const schema = internals.globalSettingsSchema.call(addon)
  if (!schema) throw new Error('no schema')
  return schema
}

function keysOf(section: ConfigSection | undefined): string[] {
  return (section?.fields ?? []).flatMap((f) => ('key' in f ? [f.key] : []))
}

function field(schema: ConfigUISchema, key: string): ConfigField | undefined {
  return schema.sections.flatMap((s) => s.fields).find((f) => 'key' in f && f.key === key)
}

describe('Alexa settings page layout', () => {
  const CUSTOM_ONLY = { field: 'skillMode', equals: 'custom' }
  const CUSTOM_ONLY_KEYS = [
    'expectedAudience',
    '__ingress-token-info',
    '__reveal-ingress-token',
    '__regenerate-ingress-token',
    'enforceIngressToken',
  ]

  it('Connection, Features, Account link, then collapsed Troubleshooting and Custom-skill security', () => {
    const schema = schemaFor('public')
    expect(schema.sections.map((s) => s.title)).toEqual([
      'Connection',
      'Features',
      'Account link',
      'Troubleshooting',
      'Custom-skill security',
    ])
    for (const section of schema.sections.slice(3)) {
      expect(section.style).toBe('accordion')
      expect(section.defaultCollapsed).toBe(true)
    }
  })

  it('the page is the same in both modes: the form, not the build, decides what shows', () => {
    expect(schemaFor('custom')).toEqual(schemaFor('public'))
  })

  it('every custom-skill row is gated on skillMode, and nothing else is', () => {
    const fields = schemaFor('public').sections.flatMap((s) => s.fields)
    const gated = fields.flatMap((f) => ('showWhen' in f && f.showWhen ? [f] : []))
    expect(gated.map((f) => ('key' in f ? f.key : ''))).toEqual(CUSTOM_ONLY_KEYS)
    for (const f of gated) expect('showWhen' in f ? f.showWhen : null).toEqual(CUSTOM_ONLY)
  })

  it('Custom-skill security holds only gated rows, so public mode draws none of it', () => {
    const security = schemaFor('public').sections.find((s) => s.title === 'Custom-skill security')
    expect(keysOf(security)).toEqual(CUSTOM_ONLY_KEYS.slice(1))
    for (const f of security?.fields ?? []) {
      expect('showWhen' in f ? f.showWhen : null).toEqual(CUSTOM_ONLY)
    }
  })

  it('places each row in its section', () => {
    const schema = schemaFor('public')
    const [connection, features, account, trouble] = schema.sections
    expect(keysOf(connection)).toEqual(['skillMode', 'region', 'expectedAudience', 'publicHubUrl'])
    expect(keysOf(features)).toEqual(['detectionSensors', 'objectDetection', 'snapshots'])
    expect(keysOf(account)).toEqual(['__alexa-link-status', '__unlink-alexa-accounts'])
    expect(keysOf(trouble)).toEqual([
      '__resync-discovery',
      '__remove-alexa-endpoints',
      '__rotate-broker-credential',
    ])
  })

  it('the external address is picked from a live list, with no refresh button', () => {
    const picker = field(schemaFor('public'), 'publicHubUrl')
    expect(picker?.type).toBe('addon-action-select')
    expect(picker && 'action' in picker ? picker.action : null).toBe('listExternalAddresses')
  })

  it('every action is an addon-action-button that says what happened', () => {
    for (const mode of ['public', 'custom'] as const) {
      const fields = schemaFor(mode).sections.flatMap((s) => s.fields)
      expect(fields.filter((f) => f.type === 'button')).toEqual([])
      for (const f of fields) {
        if (f.type !== 'addon-action-button') continue
        expect({ key: f.key, successMessage: f.successMessage ?? null }).not.toEqual({
          key: f.key,
          successMessage: null,
        })
        expect(Object.keys(exportAlexaActions)).toContain(f.action)
      }
    }
  })

  it('"Remove ids from Alexa" asks for the ids instead of reading a saved field', () => {
    const remove = field(schemaFor('public'), '__remove-alexa-endpoints')
    expect(remove?.type).toBe('addon-action-button')
    if (remove?.type !== 'addon-action-button') return
    expect(remove.action).toBe('removeAlexaEndpoints')
    expect(remove.prompt?.param).toBe('endpointIds')
    expect(field(schemaFor('public'), 'staleEndpointPurgeInput')).toBeUndefined()
  })
})
