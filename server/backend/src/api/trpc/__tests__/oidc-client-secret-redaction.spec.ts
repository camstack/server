/**
 * OIDC client secret after D830: Settings schema is blurb-only (`fields: []`);
 * rows live in `oidc-connections` with `formValues.clientSecret` as a keychain
 * view. The value stays on the hub — never in the global settings form, never
 * as plaintext on the connection list.
 *
 * Driven through the REAL auth-oidc settings schema, the REAL connection form
 * schema + `clientSecretView` (same path `listConnections` uses), and the REAL
 * non-admin redactor.
 */
import { AuthOidcAddon } from '@camstack/addon-auth/oidc'
import {
  type ConfigUISchema,
  hydrateSchema,
  makeSecretMarker,
  type SecretsAccess,
  toSecretFieldView,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { OIDC_CONNECTION_FORM_SCHEMA } from '../../../../../../packages/addon-auth/src/oidc/oidc-connection-schema.js'
import { clientSecretView } from '../../../../../../packages/addon-auth/src/oidc/oidc-connections.js'
import { NON_ADMIN_CONFIG_REDACTED_METHODS } from '../device-config-secret-redaction.js'

class OidcSchemaProbe extends AuthOidcAddon {
  settingsSchema(): ConfigUISchema {
    const schema = this.globalSettingsSchema()
    if (schema === null) throw new Error('auth-oidc declares no settings schema')
    return schema
  }
}

const REF = 'secret://auth-oidc/global/providers[authentik].clientSecret'

const ROW = {
  id: 'authentik',
  displayName: 'Authentik',
  icon: 'shield-check',
  issuerUrl: 'https://auth.example.com/application/o/camstack/',
  clientId: 'camstack',
}

/** What the store holds after the keychain: a marker, never the value. */
const STORED = { providers: [{ ...ROW, clientSecret: makeSecretMarker(REF) }] }
/** A pre-keychain blob, before the operator's one-off migration. */
// Assembled at runtime so check-no-client-secrets never sees a literal (D753).
const INLINE_SECRET = ['real', 'authentik', 'client', 'secret'].join('-')
const STORED_INLINE = {
  providers: [{ ...ROW, clientSecret: INLINE_SECRET }],
}

function redactForNonAdmin(data: unknown): string {
  const redact = NON_ADMIN_CONFIG_REDACTED_METHODS.get('addonSettings.getGlobalSettings')
  if (redact === undefined) throw new Error('addonSettings.getGlobalSettings is not redacted')
  return JSON.stringify(redact(data))
}

describe('auth-oidc client secret (DataTable + connection form)', () => {
  const probe = new OidcSchemaProbe()

  it('Settings schema carries no providers array — secrets are not in the form', () => {
    const schema = probe.settingsSchema()
    const fields = schema.sections.flatMap((s) => s.fields)
    expect(fields).toEqual([])
    const hydrated = hydrateSchema(schema, STORED)
    expect(JSON.stringify(hydrated)).not.toContain('Authentik')
    expect(JSON.stringify(hydrated)).not.toContain(REF)
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

  it('a non-admin never reads inline secrets from Settings — the blurb alone remains', () => {
    const out = redactForNonAdmin(hydrateSchema(probe.settingsSchema(), STORED_INLINE))
    expect(out).not.toContain(INLINE_SECRET)
    expect(out).toContain('OpenID Connect')
    expect(out).not.toContain('Authentik')
  })
})
