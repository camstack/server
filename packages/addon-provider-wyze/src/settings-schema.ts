import type { ConfigUISchema } from '@camstack/types'

/**
 * Provider-level (global) settings: the shared Wyze cloud credentials.
 *
 * Wyze auth needs a developer **API Key + Key ID** in addition to the
 * account email + password (the `Apikey` / `Keyid` headers). MFA accounts
 * cannot be onboarded — the bridge library has no MFA-completion flow.
 */
export function buildSettingsSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'credentials',
        title: 'Wyze account',
        titleKey: 'provider-wyze:settings.s_credentials.title',
        description:
          'Needs a developer API Key + Key ID (developer-api-console.wyze.com) besides your login. MFA accounts are not supported.',
        descriptionKey: 'provider-wyze:settings.s_credentials.description',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'email',
            label: 'Email',
            labelKey: 'provider-wyze:settings.s_credentials.email.label',
            required: true,
            placeholder: 'you@example.com',
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-wyze:settings.s_credentials.password.label',
            required: true,
            showToggle: true,
          },
          {
            type: 'password',
            key: 'apiKey',
            label: 'API Key',
            labelKey: 'provider-wyze:settings.s_credentials.apiKey.label',
            required: true,
            showToggle: true,
          },
          {
            type: 'text',
            key: 'apiId',
            label: 'Key ID',
            labelKey: 'provider-wyze:settings.s_credentials.apiId.label',
            required: true,
          },
        ],
      },
    ],
  }
}
