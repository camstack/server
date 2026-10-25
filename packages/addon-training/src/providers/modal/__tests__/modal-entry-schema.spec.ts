import { describe, expect, it } from 'vitest'
import { MODAL_ENTRY_CONFIG_SCHEMA, MODAL_ENTRY_CREATE_VALUES } from '../modal-entry-schema.js'

describe('MODAL_ENTRY_CONFIG_SCHEMA', () => {
  it('declares tokenSecret as a password field for ConfigFormBuilder', () => {
    const fields = MODAL_ENTRY_CONFIG_SCHEMA.sections.flatMap((s) => s.fields)
    const secret = fields.find((f) => 'key' in f && f.key === 'tokenSecret')
    expect(secret).toMatchObject({ type: 'password', key: 'tokenSecret' })
    expect(fields.some((f) => 'key' in f && f.key === 'tokenId')).toBe(true)
    expect(fields.some((f) => f.type === 'editable-array')).toBe(false)
  })

  it('uses columns: 2 on credential and defaults sections', () => {
    expect(MODAL_ENTRY_CONFIG_SCHEMA.sections.every((s) => s.columns === 2)).toBe(true)
  })

  it('create values leave tokenSecret empty so KeychainOr uses PasswordField', () => {
    expect(MODAL_ENTRY_CREATE_VALUES['tokenSecret']).toBe('')
  })
})
