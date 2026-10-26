import { describe, expect, it } from 'vitest'
import {
  HOMECOM_POINTT_API_ORIGIN,
  buildHomeComFormSchema,
  connectionFromSettings,
  homeComApiBase,
  homeComConfigSchema,
} from '../config.js'

describe('homeCom config', () => {
  it('uses one PointT origin for eu and us (homecom_alt)', () => {
    expect(homeComApiBase('eu')).toBe(HOMECOM_POINTT_API_ORIGIN)
    expect(homeComApiBase('us')).toBe(HOMECOM_POINTT_API_ORIGIN)
  })

  it('marks username as secret in schema meta', () => {
    const username = homeComConfigSchema.shape.username
    expect(username.meta()?.secret).toBe(true)
  })

  it('treats a blank gateway id as absent so the token can list gateways', () => {
    const parsed = connectionFromSettings({
      token: 'access',
      refresh: 'refresh',
      gatewayId: '',
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.gatewayId).toBeUndefined()
  })

  it('explains how to copy the sign-in code before the login button', () => {
    const fields = buildHomeComFormSchema().sections[0]?.fields ?? []
    const helpAt = fields.findIndex((field) => field.key === '__homecom-code-help')
    const signInAt = fields.findIndex((field) => field.key === '__homecom-sign-in')
    expect(helpAt).toBeGreaterThanOrEqual(0)
    expect(signInAt).toBeGreaterThan(helpAt)
    const help = fields[helpAt]
    expect(help?.type).toBe('info')
    if (help?.type !== 'info') return
    expect(help.label).toContain('Preserve log')
    expect(help.label).toContain('com.bosch.tt.dashtt.pointt://app/login?code=')
    expect(help.label).toMatch(/phone/i)
    expect(help.labelKey).toBe('provider-bosch:homecom.s_account.__homecom-code-help.label')
  })
})
