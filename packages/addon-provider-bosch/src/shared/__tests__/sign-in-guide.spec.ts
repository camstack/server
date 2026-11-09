import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConfigField, ConfigUISchema } from '@camstack/types'
import { buildHomeConnectFormSchema } from '../../home-connect/config.js'
import { homeConnectActions } from '../../home-connect/custom-actions.js'
import { buildHomeComFormSchema } from '../../homecom/config.js'
import { homeComActions } from '../../homecom/custom-actions.js'

function load(lang: 'en' | 'it'): Record<string, string> {
  return JSON.parse(
    readFileSync(new URL(`../../../i18n/${lang}.json`, import.meta.url), 'utf8'),
  ) as Record<string, string>
}

function fieldsOf(schema: ConfigUISchema): readonly ConfigField[] {
  return schema.sections.flatMap((section) => section.fields)
}

const FORMS = [
  [
    'HomeCom',
    buildHomeComFormSchema,
    homeComActions,
    'com.bosch.tt.dashtt.pointt://app/login?code=',
  ],
  ['Home Connect', buildHomeConnectFormSchema, homeConnectActions, 'hcauth://auth/prod?code='],
] as const

describe.each(FORMS)('%s sign-in guide', (_name, build, actions, redirectStart) => {
  const fields = fieldsOf(build())
  const signInAt = fields.findIndex((field) => field.type === 'account-sign-in')
  const guide = fields.slice(0, signInAt).filter((field) => field.type === 'info')

  it('runs through the user own browser: no hub login proxy, no claim action', () => {
    const signIn = fields[signInAt]
    expect(signIn?.type).toBe('account-sign-in')
    if (signIn?.type !== 'account-sign-in') return
    expect('claimAction' in signIn).toBe(false)
    expect('claimSignIn' in actions).toBe(false)
  })

  it('explains the steps before the button, per browser, naming the address to copy', () => {
    const text = guide.map((field) => field.label).join('\n')
    expect(guide.length).toBeGreaterThanOrEqual(6)
    expect(text).toContain(redirectStart)
    for (const browser of ['Chrome', 'Firefox', 'Safari']) expect(text).toContain(browser)
    expect(text).toMatch(/paste/i)
  })

  it('has an English and an Italian line for every guide row', () => {
    const en = load('en')
    const it_ = load('it')
    for (const field of guide) {
      const key = field.labelKey?.replace('provider-bosch:', '') ?? ''
      expect(en[key], key).toBe(field.label)
      expect(it_[key], key).toBeTruthy()
      expect(it_[key]).not.toBe(en[key])
    }
  })
})
