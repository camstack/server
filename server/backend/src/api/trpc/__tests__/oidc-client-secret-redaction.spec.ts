/**
 * OIDC client secret on the instance model (D1013): the addon declares no Settings form, and the
 * rows are `integration-instances` records whose `formValues.clientSecret` is a keychain view.
 * The value stays on the hub — never in the global settings form, never plaintext on the list.
 *
 * Driven through the REAL auth-oidc addon and the REAL connection form schema; the listed-view
 * behaviour itself (view, locked keychain) is pinned in the addon's own spec.
 */
import { AuthOidcAddon } from '@camstack/addon-auth/oidc'
import { makeSecretMarker, toSecretFieldView } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { OIDC_CONNECTION_FORM_SCHEMA } from '../../../../../../packages/addon-auth/src/oidc/oidc-connection-schema.js'

const REF = 'secret://auth/oidc-provider/authentik/clientSecret'

// Assembled at runtime so check-no-client-secrets never sees a literal (D753).
const INLINE_SECRET = ['real', 'authentik', 'client', 'secret'].join('-')

describe('auth-oidc client secret (instances table + connection form)', () => {
  const probe = new AuthOidcAddon()

  it('declares no Settings form — the client secret has no global field to land in', async () => {
    expect(await probe.listScopedSettings()).toEqual([])
  })

  it('the connection form declares a password clientSecret (keychain path)', () => {
    const password = OIDC_CONNECTION_FORM_SCHEMA.sections
      .flatMap((s) => s.fields)
      .find((f) => f.type === 'password' && f.key === 'clientSecret')
    expect(password).toMatchObject({ type: 'password', key: 'clientSecret' })
  })

  it('a stored marker is shown as a view that round-trips as KEEP', () => {
    expect(toSecretFieldView(makeSecretMarker(REF))).toEqual({ $secret: REF, v: 1, set: true })
  })

  it('an inline value shows as set, and the value never reaches the form', () => {
    const view = toSecretFieldView(INLINE_SECRET)
    expect(JSON.stringify(view)).not.toContain(INLINE_SECRET)
    expect(view).toEqual({ $secret: null, v: 1, set: true, inline: true })
  })
})
