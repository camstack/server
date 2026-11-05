/**
 * OIDC client secret after D830: the addon declares no Settings form at all
 * (D986 M4 dropped the blurb-only one); rows live in `oidc-connections` with `formValues.clientSecret` as a keychain
 * view. The value stays on the hub — never in the global settings form, never
 * as plaintext on the connection list.
 *
 * Driven through the REAL auth-oidc addon, the REAL connection form schema +
 * `clientSecretView` (same path `listConnections` uses).
 */
import { AuthOidcAddon } from '@camstack/addon-auth/oidc'
import {
  type ConfigUISchema,
  makeSecretMarker,
  type SecretsAccess,
  toSecretFieldView,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { OIDC_CONNECTION_FORM_SCHEMA } from '../../../../../../packages/addon-auth/src/oidc/oidc-connection-schema.js'
import { clientSecretView } from '../../../../../../packages/addon-auth/src/oidc/oidc-connections.js'

class OidcSchemaProbe extends AuthOidcAddon {
  settingsSchema(): ConfigUISchema | null {
    return this.globalSettingsSchema()
  }
}

const REF = 'secret://auth-oidc/global/providers[authentik].clientSecret'

/** A pre-keychain blob, before the operator's one-off migration. */
// Assembled at runtime so check-no-client-secrets never sees a literal (D753).
const INLINE_SECRET = ['real', 'authentik', 'client', 'secret'].join('-')
describe('auth-oidc client secret (DataTable + connection form)', () => {
  const probe = new OidcSchemaProbe()

  it('declares no Settings form — the client secret has no global field to land in', () => {
    expect(probe.settingsSchema()).toBeNull()
  })

  it('the connection form declares a password clientSecret (keychain path)', () => {
    const password = OIDC_CONNECTION_FORM_SCHEMA.sections
      .flatMap((s) => s.fields)
      .find((f) => f.type === 'password' && f.key === 'clientSecret')
    expect(password).toMatchObject({ type: 'password', key: 'clientSecret' })
  })

  it('listConnections formValues carry the marker view, which round-trips as KEEP', () => {
    expect(clientSecretView(makeSecretMarker(REF), undefined, 'authentik')).toEqual({
      $secret: REF,
      v: 1,
      set: true,
    })
    // Same shape hydrateSchema used to put on editable-array rows (D789).
    expect(toSecretFieldView(makeSecretMarker(REF))).toEqual({ $secret: REF, v: 1, set: true })
  })

  it('a pre-keychain inline value shows as set, and the value never reaches the form', () => {
    const secrets = {
      ref: () => REF,
    } as unknown as SecretsAccess
    const view = clientSecretView(INLINE_SECRET, secrets, 'authentik')
    expect(JSON.stringify(view)).not.toContain(INLINE_SECRET)
    expect(view).toEqual({ $secret: REF, v: 1, set: true })
    // Without a secrets handle, the view is still redacted (inline flag only).
    expect(toSecretFieldView(INLINE_SECRET)).toEqual({
      $secret: null,
      v: 1,
      set: true,
      inline: true,
    })
  })
})
