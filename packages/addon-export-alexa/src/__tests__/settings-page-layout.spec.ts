/**
 * The exporter settings page pattern: Connection / Features / Account link /
 * one collapsed Troubleshooting section, every action an `addon-action-button`
 * that reports its outcome, and rows that belong to the custom skill gated by
 * `showWhen` on `skillMode`. The skill's own values (mode, region, audience, feature switches, the
 * ingress-token enforcement) are the INSTANCE form of the `skills` record (D987); the addon page
 * keeps the account link, the troubleshooting actions and, in custom mode, the ingress-token rows.
 */
import { describe, expect, it } from 'vitest'
import type { ConfigField, ConfigSection, ConfigUISchema } from '@camstack/types'
import { exportAlexaActions } from '../custom-actions.js'
import { ExportAlexaAddon } from '../export-alexa.addon.js'
import { buildAlexaInstanceSections } from '../settings-schema.js'
import { ALEXA_SKILL_DEFAULT_BODY } from '../skill-records.js'

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

  it('the instance form is Connection, Features, Custom-skill security', () => {
    const sections = buildAlexaInstanceSections({ defaults: ALEXA_SKILL_DEFAULT_BODY })
    expect(sections.map((s) => s.title)).toEqual([
      'Connection',
      'Features',
      'Custom-skill security',
    ])
    expect(keysOf(sections[0])).toEqual(['skillMode', 'region', 'expectedAudience'])
    expect(keysOf(sections[1])).toEqual(['detectionSensors', 'objectDetection', 'snapshots'])
    expect(keysOf(sections[2])).toEqual(['enforceIngressToken'])
  })

  it('every custom-skill row of the instance form is gated on skillMode, and nothing else is', () => {
    const fields = buildAlexaInstanceSections({ defaults: ALEXA_SKILL_DEFAULT_BODY }).flatMap(
      (s) => s.fields,
    )
    const gated = fields.flatMap((f) => ('showWhen' in f && f.showWhen ? [f] : []))
    expect(gated.map((f) => ('key' in f ? f.key : ''))).toEqual([
      'expectedAudience',
      'enforceIngressToken',
    ])
    for (const f of gated) expect('showWhen' in f ? f.showWhen : null).toEqual(CUSTOM_ONLY)
  })

  it('public mode: the page is the account link, then collapsed Troubleshooting', () => {
    const schema = schemaFor('public')
    expect(schema.sections.map((s) => s.title)).toEqual(['Account link', 'Troubleshooting'])
    const [account, trouble] = schema.sections
    expect(keysOf(account)).toEqual(['__alexa-link-status', '__unlink-alexa-accounts'])
    expect(trouble?.style).toBe('accordion')
    expect(trouble?.defaultCollapsed).toBe(true)
    expect(keysOf(trouble)).toEqual([
      '__resync-discovery',
      '__remove-alexa-endpoints',
      '__rotate-broker-credential',
    ])
  })

  it('custom mode adds the ingress-token rows, collapsed, and nothing public mode shows moves', () => {
    const custom = schemaFor('custom')
    expect(custom.sections.map((s) => s.title)).toEqual([
      'Account link',
      'Troubleshooting',
      'Custom-skill ingress token',
    ])
    const security = custom.sections[2]
    expect(security?.style).toBe('accordion')
    expect(security?.defaultCollapsed).toBe(true)
    expect(keysOf(security)).toEqual([
      '__ingress-token-info',
      '__reveal-ingress-token',
      '__regenerate-ingress-token',
    ])
  })

  it('holds no external-address picker: the public origin is the Network page role', () => {
    expect(field(schemaFor('public'), 'publicHubUrl')).toBeUndefined()
    expect(field(schemaFor('custom'), 'publicHubUrl')).toBeUndefined()
  })

  it('every action is an addon-action-button that says what happened', () => {
    for (const mode of ['public', 'custom'] as const) {
      const fields = schemaFor(mode).sections.flatMap((s) => s.fields)
      expect(fields.filter((f) => f.type === 'button')).toEqual([])
      for (const f of fields) {
        if (f.type !== 'addon-action-button') continue
        expect({
          key: f.key,
          successMessage: f.successMessage ?? null,
        }).not.toEqual({
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
