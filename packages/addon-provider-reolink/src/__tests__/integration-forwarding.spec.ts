/**
 * Reolink is the first consumer of INTEGRATION-LEVEL SETTINGS: it declares that
 * its email/SMTP push sections ARE the configuration of its integration, so an
 * operator finds them under System → Integrations → Reolink.
 *
 * These assertions are the provider half of the contract. The core half —
 * that the declaration selects sections out of the ONE global schema, drops
 * `perNode` fields, and throws on an unknown id — lives in
 * `packages/types/__tests__/base-addon-integration-settings.test.ts`. The UI
 * half is in `addon-admin-ui/src/components/settings/__tests__/`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { ConfigField, ConfigSection } from '@camstack/types'
import { buildEmailPushSettingsSchema, EMAIL_PUSH_SECTION_IDS } from '../email-push-schema.js'
import {
  buildBaichuanWebhookSettingsSchema,
  BAICHUAN_WEBHOOK_SECTION_IDS,
} from '../baichuan-webhook-schema.js'

const INTEGRATION_SECTION_IDS = [...EMAIL_PUSH_SECTION_IDS, ...BAICHUAN_WEBHOOK_SECTION_IDS]

const schema = {
  sections: [
    ...buildEmailPushSettingsSchema('192.168.10.9').sections,
    ...buildBaichuanWebhookSettingsSchema('192.168.10.9').sections,
  ],
}

function keysOf(fields: readonly ConfigField[]): string[] {
  return fields.flatMap((field) => ('key' in field ? [field.key] : []))
}

function declared(): readonly ConfigSection[] {
  return schema.sections.filter((section) => INTEGRATION_SECTION_IDS.includes(section.id))
}

const here = dirname(fileURLToPath(import.meta.url))
const addonSource = readFileSync(resolve(here, '../addon.ts'), 'utf8')
const schemaSource = readFileSync(resolve(here, '../email-push-schema.ts'), 'utf8')

describe('the declaration', () => {
  it('names ids that exist in the schema', () => {
    const known = schema.sections.map((s) => s.id)
    for (const id of INTEGRATION_SECTION_IDS) expect(known).toContain(id)
  })

  it('is wired into the addon through the core hook', () => {
    // The whole mechanism hangs off this one override. Without it core answers
    // `null` and the integration page shows nothing — silently.
    expect(addonSource).toMatch(
      /protected override integrationSettingSections\(\): readonly string\[\] \{\s*return \[\.\.\.EMAIL_PUSH_SECTION_IDS, \.\.\.BAICHUAN_WEBHOOK_SECTION_IDS\]/,
    )
  })

  it('declares the SCHEMA rather than overriding the getter', () => {
    // `getIntegrationSettings` selects sections out of `globalSettingsSchema()`.
    // An addon that hides its schema behind a `getGlobalSettings()` override
    // leaves core with nothing to select from — that was Reolink's old shape.
    expect(addonSource).toMatch(/protected override globalSettingsSchema\(\): ConfigUISchema/)
    expect(addonSource).not.toMatch(/override async getGlobalSettings\(/)
  })
})

describe('what Reolink declares as its integration settings', () => {
  it('is email-push + HaCfg webhook sections', () => {
    expect(declared().map((s) => s.id)).toEqual([
      'email-push',
      'email-push-auth',
      'baichuan-webhook',
    ])
  })

  it('is the SMTP keys plus HaCfg webhook keys', () => {
    expect(declared().flatMap((section) => keysOf(section.fields))).toEqual([
      'emailPushEnabled',
      'emailPushRecommendedHost',
      'emailPushPort',
      'emailPushDomain',
      'emailPushRequireAuth',
      'emailPushAuthUsername',
      'emailPushAuthPassword',
      'baichuanWebhookEnabled',
      'baichuanWebhookRecommendedHost',
      'baichuanWebhookPort',
      'baichuanWebhookBindHost',
    ])
  })

  it('contains nothing per-node', () => {
    // Core drops `perNode` fields anyway; a provider that declares one has
    // misunderstood the surface, so it is caught here as well.
    const perNode = declared()
      .flatMap((section) => section.fields)
      .filter((field) => 'perNode' in field && field.perNode === true)
    expect(perNode).toEqual([])
  })

  it('is a SUBSET of the global schema, not a second schema', () => {
    // The same-store-key guarantee rests on this. If a future edit builds a
    // separate "integration schema", these identities diverge and the surface
    // becomes free to write a second key.
    for (const section of declared()) expect(schema.sections).toContain(section)
  })
})

describe('`tab` is not used to express placement', () => {
  it('no section borrows `tab` to mean "this lives on the integration page"', () => {
    // `tab` means "how to GROUP this visually". Overloading it put the literal
    // word "integration" into an operator-facing tab bar (D268 → D269). It
    // stays available for grouping WITHIN the integration page — it just may
    // never be the declaration.
    expect(schemaSource).not.toMatch(/tab:\s*['"]integration['"]/)
    expect(schemaSource).not.toContain('INTEGRATION_SURFACE_TAB')
    for (const section of schema.sections) expect(section.tab).toBeUndefined()
  })
})
