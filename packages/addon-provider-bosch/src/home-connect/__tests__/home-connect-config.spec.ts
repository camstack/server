import { describe, expect, it } from 'vitest'
import {
  buildHomeConnectFormSchema,
  connectionFromSettings,
  HOME_CONNECT_PAIRED_ONLY,
  homeConnectSettingsForPersist,
  sameHomeConnectConnection,
} from '../config.js'

const haDeviceDescription = {
  info: {
    deviceID: 'HAI-DW-OBJ-1',
    deviceType: 'Dishwasher',
    model: 'SMS6ZCI45E',
  },
  program: [{ name: 'Eco50', uid: 'BSH.Common.Program.Eco50', available: true }],
}

describe('homeConnectConfigSchema / connectionFromSettings', () => {
  const base = { token: 'access', refresh: 'refresh-1' }

  it('accepts the account tokens', () => {
    expect(connectionFromSettings(base)).toEqual(base)
  })

  it('sameHomeConnectConnection matches the tokens', () => {
    const a = connectionFromSettings(base)
    const b = connectionFromSettings({ token: 'access', refresh: 'refresh-1' })
    expect(sameHomeConnectConnection(a, b)).toBe(true)
    expect(
      sameHomeConnectConnection(
        a,
        connectionFromSettings({ token: 'other', refresh: 'refresh-1' }),
      ),
    ).toBe(false)
  })
})

describe('homeConnectSettingsForPersist', () => {
  it('parses JSON string into object for json valueType storage', () => {
    const raw = {
      host: '192.168.0.10',
      deviceDescription: JSON.stringify(haDeviceDescription),
    }
    const out = homeConnectSettingsForPersist(raw)
    expect(out['deviceDescription']).toEqual(haDeviceDescription)
  })

  it('leaves object deviceDescription unchanged', () => {
    const raw = { host: '1.2.3.4', deviceDescription: haDeviceDescription }
    expect(homeConnectSettingsForPersist(raw)).toEqual(raw)
  })

  it('drops the sign-in email and password', () => {
    const out = homeConnectSettingsForPersist({
      host: '1.2.3.4',
      accountEmail: 'a@b.c',
      accountPassword: 'secret-value',
    })
    expect(out['accountEmail']).toBeUndefined()
    expect(out['accountPassword']).toBeUndefined()
    expect(out['host']).toBe('1.2.3.4')
  })
})

describe('buildHomeConnectFormSchema', () => {
  it('asks for the account and hides the raw gateway fields', () => {
    const fields = buildHomeConnectFormSchema().sections[0]?.fields ?? []
    const keys = fields.map((field) => field.key)
    expect(keys).toContain('__home-connect-sign-in')
    expect(keys).not.toContain('authorizeUrl')
    expect(keys).not.toContain('callback')
    expect(keys).not.toContain('verifier')
    const advanced = fields.find((field) => field.key === '__home-connect-advanced')
    expect(advanced?.type).toBe('group')
    if (advanced?.type === 'group') {
      const token = advanced.fields.find((field) => field.key === 'token')
      expect(token?.type).toBe('password')
    }
    const appliances = fields.find((field) => field.key === 'appliances')
    expect(appliances && 'showWhen' in appliances ? appliances.showWhen : undefined).toEqual({
      field: '__hidden__',
      equals: HOME_CONNECT_PAIRED_ONLY,
    })
    expect(keys).not.toContain('host')
    expect(keys).not.toContain('accountPassword')
  })
})
