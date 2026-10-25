import { describe, it, expect } from 'vitest'
import { haBrokerSettingsSchema } from '../ha-broker-settings-schema.js'

describe('HA broker settings schema', () => {
  it('exposes baseUrl + accessToken + auth kind fields, no brokerSource', () => {
    const keys = haBrokerSettingsSchema.sections.flatMap((s) => s.fields.map((f) => f.key))
    expect(keys).toContain('baseUrl')
    expect(keys).toContain('accessToken')
    expect(keys).toContain('authKind')
    expect(keys).toContain('supervisorToken')
    expect(keys).not.toContain('brokerSource') // belongs to the wizard, not the broker
    expect(keys).not.toContain('brokerId')
  })
})
