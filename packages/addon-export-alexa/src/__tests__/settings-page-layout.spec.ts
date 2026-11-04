/**
 * The exporter page pattern, on the form of ONE skill: Connection / Features / Custom-skill
 * security / Account link / one collapsed Troubleshooting / the ingress-token rows, every action
 * an `addon-action-button` that reports its outcome and names the skill it acts on
 * (`paramsStatic: { instanceId }`). Rows that belong to the custom skill are gated by `showWhen`
 * on `skillMode` for the first skill; a later skill always has its own Lambda and token. The
 * addon has no settings page of its own any more: the skills ARE the page.
 */
import { describe, expect, it } from 'vitest'
import type { ConfigField, ConfigSection } from '@camstack/types'
import { exportAlexaActions } from '../custom-actions.js'
import { ExportAlexaAddon } from '../export-alexa.addon.js'
import { buildAlexaInstanceSections } from '../settings-schema.js'
import { ALEXA_SKILL_DEFAULT_BODY } from '../skill-records.js'

function form(opts: { id: string | null; legacy: boolean }): ConfigSection[] {
  return buildAlexaInstanceSections({
    defaults: ALEXA_SKILL_DEFAULT_BODY,
    instanceId: opts.id,
    legacy: opts.legacy,
    linkedAccounts: [],
    tokens: [],
    now: 0,
  })
}

function keysOf(section: ConfigSection | undefined): string[] {
  return (section?.fields ?? []).flatMap((f) => ('key' in f ? [f.key] : []))
}

function fieldsOf(sections: readonly ConfigSection[]): ConfigField[] {
  return sections.flatMap((s) => s.fields)
}

describe('Alexa skill form', () => {
  const CUSTOM_ONLY = { field: 'skillMode', equals: 'custom' }

  it('the create form is the fields only: no action can name a skill that does not exist yet', () => {
    const sections = form({ id: null, legacy: false })
    expect(sections.map((s) => s.title)).toEqual([
      'Connection',
      'Features',
      'Custom-skill security',
    ])
    expect(fieldsOf(sections).filter((f) => f.type === 'addon-action-button')).toEqual([])
  })

  it('a saved skill adds Account link, collapsed Troubleshooting and the ingress token', () => {
    const sections = form({ id: 'alexa-skill-1', legacy: false })
    expect(sections.map((s) => s.title)).toEqual([
      'Connection',
      'Features',
      'Custom-skill security',
      'Account link',
      'Troubleshooting',
      'Ingress token',
    ])
    expect(keysOf(sections[3])).toEqual(['__alexa-link-status', '__unlink-alexa-accounts'])
    expect(sections[4]?.style).toBe('accordion')
    expect(sections[4]?.defaultCollapsed).toBe(true)
    expect(keysOf(sections[4])).toEqual([
      '__resync-discovery',
      '__remove-alexa-endpoints',
      '__rotate-broker-credential',
    ])
    expect(sections[5]?.style).toBe('accordion')
    expect(keysOf(sections[5])).toEqual([
      '__ingress-token-info',
      '__reveal-ingress-token',
      '__regenerate-ingress-token',
    ])
  })

  it('the first skill gates its custom-skill rows on skillMode; a later skill gates only the audience', () => {
    const first = fieldsOf(form({ id: 'export-alexa', legacy: true }))
    const gatedFirst = first.flatMap((f) => ('showWhen' in f && f.showWhen ? [f] : []))
    expect(gatedFirst.map((f) => ('key' in f ? f.key : ''))).toEqual([
      'expectedAudience',
      'enforceIngressToken',
      '__ingress-token-info',
      '__reveal-ingress-token',
      '__regenerate-ingress-token',
    ])
    for (const f of gatedFirst) expect('showWhen' in f ? f.showWhen : null).toEqual(CUSTOM_ONLY)

    const later = fieldsOf(form({ id: 'alexa-skill-1', legacy: false }))
    const gatedLater = later.flatMap((f) => ('showWhen' in f && f.showWhen ? [f] : []))
    expect(gatedLater.map((f) => ('key' in f ? f.key : ''))).toEqual(['expectedAudience'])
  })

  it('holds no external-address picker: the public origin is the Network page role', () => {
    const keys = fieldsOf(form({ id: 'alexa-skill-1', legacy: false })).flatMap((f) =>
      'key' in f ? [f.key] : [],
    )
    expect(keys).not.toContain('publicHubUrl')
  })

  it('every action says what happened and acts on THIS skill', () => {
    const fields = fieldsOf(form({ id: 'alexa-skill-1', legacy: false }))
    expect(fields.filter((f) => f.type === 'button')).toEqual([])
    const buttons = fields.filter((f) => f.type === 'addon-action-button')
    expect(buttons.length).toBe(6)
    for (const f of buttons) {
      if (f.type !== 'addon-action-button') continue
      expect(f.successMessage ?? null).not.toBeNull()
      expect(Object.keys(exportAlexaActions)).toContain(f.action)
      expect(f.paramsStatic).toEqual({ instanceId: 'alexa-skill-1' })
    }
  })

  it('"Remove ids from Alexa" asks for the ids instead of reading a saved field', () => {
    const remove = fieldsOf(form({ id: 'alexa-skill-1', legacy: false })).find(
      (f) => 'key' in f && f.key === '__remove-alexa-endpoints',
    )
    expect(remove?.type).toBe('addon-action-button')
    if (remove?.type !== 'addon-action-button') return
    expect(remove.action).toBe('removeAlexaEndpoints')
    expect(remove.prompt?.param).toBe('endpointIds')
  })

  it('every action accepts the instance id the buttons send', () => {
    for (const action of Object.values(exportAlexaActions)) {
      expect(action.input.safeParse({ instanceId: 'x', endpointIds: 'a' }).success).toBe(true)
    }
  })

  it('the addon has no page of its own: the skills are the page', () => {
    const addon = new ExportAlexaAddon()
    const internals = addon as unknown as { globalSettingsSchema: () => unknown }
    expect(internals.globalSettingsSchema.call(addon)).toBeNull()
  })
})
