import { collectKeychainStoredKeys } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { boschShcActions } from '../custom-actions.js'
import { buildConnectionFormSchema, SHC_PAIRING_ONLY_SHOW_WHEN } from '../config.js'

describe('SHC connection form', () => {
  const schema = buildConnectionFormSchema()
  const fields = schema.sections.flatMap((s) => s.fields)

  it('shows host and pairing instructions, not manual PEM or token fields', () => {
    const keys = fields.flatMap((f) => ('key' in f ? [f.key] : []))
    expect(keys).toContain('host')
    expect(keys).toContain('systemPassword')
    const register = fields.find((f) => f.type === 'addon-action-button')
    expect(register?.type).toBe('addon-action-button')
    if (register?.type !== 'addon-action-button') return
    expect(register.action).toBe('registerClient')
    expect(register.paramsFromForm).toEqual({ host: 'host', systemPassword: 'systemPassword' })
    expect(register.assignResult).toEqual({
      sslCertificate: 'sslCertificate',
      sslKey: 'sslKey',
      token: 'token',
    })
    expect(Object.keys(boschShcActions)).toContain('registerClient')
  })

  it('keeps secret cert fields hidden but keychain-eligible', () => {
    const sslCertificate = fields.find((f) => 'key' in f && f.key === 'sslCertificate')
    const sslKey = fields.find((f) => 'key' in f && f.key === 'sslKey')
    expect(sslCertificate?.type).toBe('password')
    expect(sslKey?.type).toBe('password')
    if (sslCertificate && 'showWhen' in sslCertificate) {
      expect(sslCertificate.showWhen).toEqual({
        field: 'host',
        equals: SHC_PAIRING_ONLY_SHOW_WHEN,
      })
    }
    if (sslKey && 'showWhen' in sslKey) {
      expect(sslKey.showWhen).toEqual({ field: 'host', equals: SHC_PAIRING_ONLY_SHOW_WHEN })
    }
    const token = fields.find((f) => 'key' in f && f.key === 'token')
    expect(token?.type).toBe('password')
    if (token && 'showWhen' in token) {
      expect(token.showWhen).toEqual({ field: 'host', equals: SHC_PAIRING_ONLY_SHOW_WHEN })
    }
    expect(collectKeychainStoredKeys(schema).has('sslCertificate')).toBe(true)
    expect(collectKeychainStoredKeys(schema).has('sslKey')).toBe(true)
    expect(collectKeychainStoredKeys(schema).has('token')).toBe(true)
    expect(collectKeychainStoredKeys(schema).has('systemPassword')).toBe(true)
  })

  it('marks the generated certificate and key as secrets', () => {
    const shape = boschShcActions.registerClient.output.shape
    expect(shape.sslCertificate.meta()?.secret).toBe(true)
    expect(shape.sslKey.meta()?.secret).toBe(true)
    expect(shape.token.meta()?.secret).toBe(true)
    const visiblePem = fields.filter(
      (field) =>
        'key' in field &&
        (field.key === 'sslCertificate' || field.key === 'sslKey') &&
        !('showWhen' in field && field.showWhen !== undefined),
    )
    expect(visiblePem).toEqual([])
  })
})
