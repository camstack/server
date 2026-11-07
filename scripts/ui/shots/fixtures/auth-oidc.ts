/**
 * Identity -> Authentication (`/system/identity?tab=authentication`): the OIDC identity providers
 * of `auth-oidc`. Answers the removed `oidc-connections` list (the "before" shot) and the
 * `integration-instances` records that replace it, so one fixture shoots both sides. The client
 * secret is a keychain view, never a value. Invented data only.
 */
import { defineFixtures } from './_define'

const SET = { $secret: 'secret://auth/oidc-provider/authentik/clientSecret', v: 1, set: true }

const ICON = 'shield-check'
const VALUES = {
  authentik: {
    displayName: 'Authentik',
    icon: ICON,
    issuerUrl: 'https://auth.example.com/application/o/camstack/',
    clientId: 'camstack-web',
    clientSecret: SET,
    redirectUri: '',
    scopes: 'openid profile email',
    usernameClaim: 'preferred_username',
  },
  google: {
    displayName: 'Google',
    icon: 'globe',
    issuerUrl: 'https://accounts.google.example.com',
    clientId: 'public-client',
    clientSecret: '',
    redirectUri: '',
    scopes: 'openid profile email',
    usernameClaim: 'email',
  },
} as const

const FORM = {
  sections: [
    {
      id: 'identity',
      title: 'Identity',
      columns: 2,
      fields: [
        { type: 'text', key: 'displayName', label: 'Display name', default: 'OpenID Connect' },
        { type: 'icon', key: 'icon', label: 'Icon', default: ICON },
      ],
    },
    {
      id: 'idp',
      title: 'Identity provider',
      columns: 2,
      fields: [
        { type: 'text', key: 'issuerUrl', label: 'Issuer URL', default: '' },
        { type: 'text', key: 'clientId', label: 'Client ID', default: '' },
        { type: 'password', key: 'clientSecret', label: 'Client Secret', default: '' },
        { type: 'text', key: 'redirectUri', label: 'Redirect URI override', default: '' },
        { type: 'text', key: 'scopes', label: 'Scopes', default: 'openid profile email' },
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

export default defineFixtures({
  area: 'auth-oidc',
  description: 'Identity -> Authentication with two OIDC identity providers',
  handlers: {
    // The page before the instance model.
    'oidcConnections.listConnections': [
      {
        id: 'authentik',
        displayName: 'Authentik',
        icon: ICON,
        issuerUrl: VALUES.authentik.issuerUrl,
        clientId: 'camstack-web',
        configured: true,
        formValues: VALUES.authentik,
      },
      {
        id: 'google',
        displayName: 'Google',
        icon: 'globe',
        issuerUrl: VALUES.google.issuerUrl,
        clientId: 'public-client',
        configured: true,
        formValues: VALUES.google,
      },
    ],
    'oidcConnections.connectionFormSchema': FORM,
    // The page on the instance model.
    'integrationInstances.describe': {
      role: 'services',
      instanceMode: 'multiple',
      kind: 'login-method',
      canTest: false,
      kinds: [{ id: 'oidc-provider', label: 'OpenID Connect', functionCap: 'login-method' }],
    },
    'integrationInstances.instanceFormSchema': FORM,
    'integrationInstances.listInstances': [
      {
        id: 'authentik',
        name: 'Authentik',
        configured: true,
        enabled: true,
        kind: 'oidc-provider',
        formValues: VALUES.authentik,
      },
      {
        id: 'google',
        name: 'Google',
        configured: true,
        enabled: false,
        kind: 'oidc-provider',
        formValues: VALUES.google,
      },
    ],
    'mut:integrationInstances.updateInstance': { ok: true },
    'mut:integrationInstances.createInstance': { id: 'new' },
  },
})
