import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { HaProviderAddon } from '../addon.js'

/**
 * D986 M4: the Home Assistant provider's integration-level form is the instance form
 * (`integrationFormSchema`), not the addon's global settings schema. It is informational: a
 * broker link carries no editable field, and `reconcileIntervalSec` (a ha-export target record
 * field since `targets-from-links`) is no longer an addon-settings key.
 */
class Probe extends HaProviderAddon {
  formFor(): Promise<ConfigUISchema | null> {
    return this.integrationFormSchema({ integrationId: 'broker-1', mode: 'account' })
  }
}

describe('the Home Assistant integration form', () => {
  it('is the instance form: one broker-help section, no editable field', async () => {
    const form = await new Probe().formFor()
    if (form === null) throw new Error('no instance form declared')
    expect(form.sections.map((section) => section.id)).toEqual(['ha-broker'])
    expect(form.sections.flatMap((section) => section.fields.map((field) => field.type))).toEqual([
      'info',
    ])
  })

  it('declares no addon-settings key: the scoped settings is gone', async () => {
    expect(await new Probe().listScopedSettings()).toEqual([])
  })
})
