/**
 * OIDC connection CRUD helpers + settings schema has no editable-array.
 */
import { describe, expect, it } from 'vitest'
import { AuthOidcAddon } from '../auth-oidc.addon.js'
import {
  createOidcConnection,
  deleteOidcConnection,
  updateOidcConnection,
  type OidcProvidersConfig,
} from '../oidc-connections.js'

const EMPTY: OidcProvidersConfig = { providers: [] }

describe('oidc-connections helpers', () => {
  it('createConnection rejects a non-slug id and accepts a unique slug', () => {
    expect(createOidcConnection(EMPTY, { id: 'Bad Id', displayName: 'X' }).ok).toBe(false)
    const created = createOidcConnection(EMPTY, { id: 'authentik', displayName: 'Authentik' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.id).toBe('authentik')
    expect(created.config.providers).toHaveLength(1)
    expect(createOidcConnection(created.config, { id: 'authentik', displayName: 'Dup' }).ok).toBe(
      false,
    )
  })

  it('updateConnection patches fields without renaming id; delete removes the row', () => {
    const created = createOidcConnection(EMPTY, { id: 'google', displayName: 'Google' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const updated = updateOidcConnection(created.config, 'google', {
      displayName: 'Google Workspace',
      issuerUrl: 'https://accounts.google.com',
      clientId: 'cid',
      clientSecret: 'secret',
    })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.config.providers[0]?.id).toBe('google')
    expect(updated.config.providers[0]?.displayName).toBe('Google Workspace')
    expect(updated.config.providers[0]?.clientId).toBe('cid')

    const deleted = deleteOidcConnection(updated.config, 'google')
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.config.providers).toEqual([])
  })
})

describe('AuthOidcAddon globalSettingsSchema', () => {
  it('has no editable-array providers field', () => {
    const addon = new AuthOidcAddon()
    const schema = (
      addon as unknown as {
        globalSettingsSchema: () => {
          sections: readonly { fields: readonly { type: string; key?: string }[] }[]
        }
      }
    ).globalSettingsSchema()
    const fields = schema.sections.flatMap((s) => s.fields)
    expect(fields.some((f) => f.type === 'editable-array')).toBe(false)
    expect(fields.some((f) => f.key === 'providers')).toBe(false)
  })
})
