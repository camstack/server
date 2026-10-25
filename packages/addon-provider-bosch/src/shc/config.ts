import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'

/** Operator settings for one SHC integration (local mTLS + optional token). */
export const shcConfigSchema = z.object({
  host: z.string().min(1).describe('SHC hostname or IP'),
  sslCertificate: z.string().min(1).describe('Client certificate PEM').meta({ secret: true }),
  sslKey: z.string().min(1).describe('Client private key PEM').meta({ secret: true }),
  token: z
    .string()
    .optional()
    .describe('Optional API token from the Bosch app')
    .meta({ secret: true }),
})

export type ShcConfig = z.infer<typeof shcConfigSchema>

export function settingsToShcConfig(settings: unknown): ShcConfig {
  return shcConfigSchema.parse(settings ?? {})
}

export function connectionFromSettings(settings: Record<string, unknown>): ShcConfig | null {
  const parsed = shcConfigSchema.safeParse(settings)
  return parsed.success ? parsed.data : null
}

export function sameShcConnection(a: ShcConfig | null, b: ShcConfig | null): boolean {
  if (a === null || b === null) return false
  return (
    a.host === b.host &&
    a.sslCertificate === b.sslCertificate &&
    a.sslKey === b.sslKey &&
    (a.token ?? '') === (b.token ?? '')
  )
}

/** Sentinel for `showWhen` — cert fields stay in schema/keychain but never render. */
export const SHC_PAIRING_ONLY_SHOW_WHEN = '__pairing_only__'

export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'connection',
        title: 'Smart Home Controller',
        titleKey: 'provider-bosch:shc.s_connection.title',
        description: 'Local REST access to your Bosch Smart Home Controller.',
        descriptionKey: 'provider-bosch:shc.s_connection.description',
        columns: 1,
        fields: [
          {
            type: 'addon-action-select',
            addonId: 'bosch-shc',
            key: '__shc-discovered',
            writesKey: 'host',
            omitFromSettings: true,
            label: 'Controller',
            labelKey: 'provider-bosch:shc.s_connection.__shc-discovered.label',
            action: 'discoverController',
            mapOption: { value: 'host', label: 'name' },
            hideWhenFewerThan: 2,
            emptyResultsMessage: 'No controller found on the network.',
          },
          {
            type: 'text',
            key: 'host',
            label: 'Host',
            labelKey: 'provider-bosch:shc.s_connection.host.label',
            description: 'Filled when one controller is found. Type the address if it is not.',
            descriptionKey: 'provider-bosch:shc.s_connection.host.description',
            required: false,
            placeholder: '192.0.2.20',
          },
          {
            type: 'info',
            key: '__shc-pairing-hint',
            label: 'Pair with the controller',
            content:
              'Press the button on the controller until the LED blinks. Enter the password you created in the Bosch Smart Home app, not the code printed on the controller, then register.',
          },
          {
            type: 'password',
            key: 'systemPassword',
            label: 'System password',
            labelKey: 'provider-bosch:shc.s_connection.systemPassword.label',
            required: true,
            showToggle: true,
          },
          {
            type: 'addon-action-button',
            addonId: 'bosch-shc',
            key: '__shc-register',
            label: 'Client registration',
            buttonLabel: 'Register on controller',
            action: 'registerClient',
            variant: 'primary',
            paramsFromForm: {
              host: 'host',
              systemPassword: 'systemPassword',
            },
            assignResult: {
              sslCertificate: 'sslCertificate',
              sslKey: 'sslKey',
              token: 'token',
            },
            successMessage: '{summary}',
          },
          {
            type: 'group',
            key: '__shc-advanced',
            label: 'Advanced',
            labelKey: 'provider-bosch:shc.s_connection.__shc-advanced.label',
            style: 'accordion',
            defaultCollapsed: true,
            fields: [
              {
                type: 'secret-presence',
                key: '__shc-registered',
                label: 'Client registration',
                sourceKey: 'sslCertificate',
                yesLabel: 'Client registered: yes',
                noLabel: 'Client registered: no',
              },
              {
                type: 'addon-action-button',
                addonId: 'bosch-shc',
                key: '__shc-reregister',
                label: 'Register again',
                buttonLabel: 'Register again',
                action: 'registerClient',
                paramsFromForm: {
                  host: 'host',
                  systemPassword: 'systemPassword',
                },
                assignResult: {
                  sslCertificate: 'sslCertificate',
                  sslKey: 'sslKey',
                  token: 'token',
                },
                successMessage: '{summary}',
              },
            ],
          },
          {
            type: 'password',
            key: 'token',
            label: 'Controller token',
            labelKey: 'provider-bosch:shc.s_connection.token.label',
            required: false,
            showToggle: false,
            showWhen: { field: 'host', equals: SHC_PAIRING_ONLY_SHOW_WHEN },
          },
          {
            type: 'password',
            key: 'sslCertificate',
            label: 'Client certificate (PEM)',
            labelKey: 'provider-bosch:shc.s_connection.sslCertificate.label',
            required: false,
            showToggle: true,
            showWhen: { field: 'host', equals: SHC_PAIRING_ONLY_SHOW_WHEN },
          },
          {
            type: 'password',
            key: 'sslKey',
            label: 'Client private key (PEM)',
            labelKey: 'provider-bosch:shc.s_connection.sslKey.label',
            required: false,
            showToggle: true,
            showWhen: { field: 'host', equals: SHC_PAIRING_ONLY_SHOW_WHEN },
          },
        ],
      },
    ],
  }
}
