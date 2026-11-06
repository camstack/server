// The per-kind broker creation/edit form for kind='home-assistant'.
//
// Rendered by the generic Broker manager + the wizard's "create new"
// path. This is PURE DATA — the same `select` / `text` / `password`
// field shapes the addon's `globalSettingsSchema()` uses for HA
// credentials, but WITHOUT the `brokerSource` / `brokerId` fields
// (those are wizard concerns: pick "link existing" vs "create new"
// happens one level up, in the integration wizard, not in the broker's
// own form).
//
// The flat `{ authKind, baseUrl, accessToken, supervisorToken }` shape
// this form emits is consumed by `settingsToAuth` in
// `ha-broker-registry.ts`. That validator discriminates by FIELD
// PRESENCE (`baseUrl`+`accessToken` → long-lived, `supervisorToken` →
// supervisor) and ignores `authKind`, so the conditional `showWhen`
// fields below produce exactly one valid auth shape per `authKind`.
export const haBrokerSettingsSchema = {
  sections: [
    {
      id: 'ha-broker-credentials',
      title: 'Home Assistant connection',
      titleKey: 'provider-homeassistant:haBrokerSettings.s_ha-broker-credentials.title',
      columns: 1,
      fields: [
        {
          type: 'select',
          key: 'authKind',
          label: 'Auth mode',
          labelKey:
            'provider-homeassistant:haBrokerSettings.s_ha-broker-credentials.authKind.label',
          options: [
            {
              value: 'long-lived',
              label: 'Long-lived token',
              labelKey:
                'provider-homeassistant:haBrokerSettings.s_ha-broker-credentials.authKind.o_long-lived.label',
            },
            {
              value: 'supervisor',
              label: 'Supervisor (HA add-on)',
              labelKey:
                'provider-homeassistant:haBrokerSettings.s_ha-broker-credentials.authKind.o_supervisor.label',
            },
          ],
          default: 'long-lived',
        },
        {
          type: 'text',
          key: 'baseUrl',
          label: 'HA base URL',
          labelKey: 'provider-homeassistant:haBrokerSettings.s_ha-broker-credentials.baseUrl.label',
          placeholder: 'https://ha.example:8123',
          showWhen: { field: 'authKind', equals: 'long-lived' },
        },
        {
          type: 'password',
          key: 'accessToken',
          label: 'Long-lived access token',
          labelKey:
            'provider-homeassistant:haBrokerSettings.s_ha-broker-credentials.accessToken.label',
          showToggle: true,
          showWhen: { field: 'authKind', equals: 'long-lived' },
        },
        {
          type: 'password',
          key: 'supervisorToken',
          label: 'Supervisor token',
          labelKey:
            'provider-homeassistant:haBrokerSettings.s_ha-broker-credentials.supervisorToken.label',
          showToggle: true,
          showWhen: { field: 'authKind', equals: 'supervisor' },
        },
      ],
    },
  ],
} as const
