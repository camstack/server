/**
 * OIDC connection form schema — drives ConfigFormBuilder in Settings
 * (DataTable + ItemFormDialog). Storage stays keychain via
 * `secretStatePaths` (`providers[id].clientSecret`).
 */
import type { ConfigUISchema } from '@camstack/types'

export const DEFAULT_OIDC_ICON = 'shield-check'

export const OIDC_CONNECTION_FORM_SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'identity',
      title: 'Identity',
      columns: 2,
      fields: [
        {
          type: 'text',
          key: 'displayName',
          label: 'Display name',
          description: 'Shown on the login button.',
          default: 'OpenID Connect',
        },
        {
          type: 'icon',
          key: 'icon',
          label: 'Icon',
          description: 'Shown on the login button.',
          default: DEFAULT_OIDC_ICON,
        },
      ],
    },
    {
      id: 'idp',
      title: 'Identity provider',
      columns: 2,
      fields: [
        {
          type: 'text',
          key: 'issuerUrl',
          label: 'Issuer URL',
          description:
            'IdP base URL — discovery doc lives at <issuer>/.well-known/openid-configuration.',
          default: '',
        },
        { type: 'text', key: 'clientId', label: 'Client ID', default: '' },
        {
          type: 'password',
          key: 'clientSecret',
          label: 'Client Secret',
          showToggle: true,
          default: '',
        },
        {
          type: 'text',
          key: 'redirectUri',
          label: 'Redirect URI override',
          description:
            'Optional — leave empty. Empty: a sign-in returns to the hub address it was started from (LAN, mesh or public, as listed on the Network page). Set: pins that one callback.',
          default: '',
        },
        {
          type: 'text',
          key: 'scopes',
          label: 'Scopes',
          description: 'Space-separated.',
          default: 'openid profile email',
        },
        {
          type: 'select',
          key: 'usernameClaim',
          label: 'Username claim',
          default: 'preferred_username',
          options: [
            { value: 'preferred_username', label: 'preferred_username' },
            { value: 'email', label: 'email' },
            { value: 'sub', label: 'sub (user id)' },
          ],
        },
      ],
    },
  ],
}

export const OIDC_CONNECTION_CREATE_VALUES: Record<string, unknown> = {
  displayName: 'OpenID Connect',
  icon: DEFAULT_OIDC_ICON,
  issuerUrl: '',
  clientId: '',
  clientSecret: '',
  redirectUri: '',
  scopes: 'openid profile email',
  usernameClaim: 'preferred_username',
}
