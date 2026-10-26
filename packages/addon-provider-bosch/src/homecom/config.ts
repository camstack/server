import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'

export const HOMECOM_BRANDS = ['bosch', 'buderus'] as const
export const HomeComBrandSchema = z.enum(HOMECOM_BRANDS)

export const HOMECOM_REGIONS = ['eu', 'us'] as const
export const HomeComRegionSchema = z.enum(HOMECOM_REGIONS)

export const homeComConfigSchema = z.object({
  /** Account email; filled by the sign-in, informational only. */
  username: z.string().optional().describe('HomeCom / PointT account email').meta({ secret: true }),
  token: z.string().min(1).describe('OAuth access token').meta({ secret: true }),
  refresh: z.string().min(1).describe('OAuth refresh token').meta({ secret: true }),
  brand: HomeComBrandSchema.default('bosch'),
  region: HomeComRegionSchema.default('eu'),
  /**
   * The gateway this integration controls. Chosen from the account list after
   * sign-in. A blank value is the same as absent: the id is not known yet.
   */
  gatewayId: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value.length === 0 ? undefined : value)),
  /** Shown on the sign-in field. Not a credential. */
  accountLabel: z.string().optional(),
  /** How many gateways the last sign-in listed. */
  gatewayCount: z.number().optional(),
})

export type HomeComConfig = z.infer<typeof homeComConfigSchema>

export function connectionFromSettings(settings: Record<string, unknown>): HomeComConfig | null {
  const parsed = homeComConfigSchema.safeParse(settings)
  return parsed.success ? parsed.data : null
}

export function sameHomeComConnection(a: HomeComConfig | null, b: HomeComConfig | null): boolean {
  if (a === null || b === null) return false
  return (
    a.username === b.username &&
    a.token === b.token &&
    a.refresh === b.refresh &&
    a.brand === b.brand &&
    a.region === b.region &&
    a.gatewayId === b.gatewayId
  )
}

/**
 * PointT REST origin (matches homecom_alt / HomeCom Easy). US and EU accounts use
 * the same host; `region` is retained for Bacon MQTT (`euc1` / `use1`) when wired.
 */
export const HOMECOM_POINTT_API_ORIGIN = 'https://pointt-api.bosch-thermotechnology.com'

/** Account gateway list. `deviceId` on each row is the gateway id. */
export const HOMECOM_GATEWAYS_PATH = '/pointt-api/api/v1/gateways/'

export function homeComApiBase(_region: HomeComConfig['region']): string {
  return HOMECOM_POINTT_API_ORIGIN
}

export const HOMECOM_SECRET_KEYS = ['username', 'token', 'refresh'] as const

const HIDDEN_UNTIL_ADVANCED = { field: '__hidden__', equals: 'yes' } as const

const HOMECOM_CODE_HELP = [
  "Before you sign in, open the browser's developer tools, choose the Network tab, and turn on Preserve log.",
  'Sign in with SingleKey. The page will say it has network problems. Ignore that: the browser tried to open the Bosch app and could not.',
  'In the Network list, filter by code= and open the request whose address starts with com.bosch.tt.dashtt.pointt://app/login?code=',
  'Copy that whole address, or only the code, and paste it in the box under the sign-in button.',
  'On a phone the same redirect fails unless the Bosch app is installed. Use a desktop browser to copy the code.',
].join('\n\n')

export function buildHomeComFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'account',
        title: 'HomeCom account',
        titleKey: 'provider-bosch:homecom.s_account.title',
        description:
          'Sign in with your SingleKey ID. Copy the code as described below, then paste it here.',
        descriptionKey: 'provider-bosch:homecom.s_account.description',
        columns: 1,
        fields: [
          {
            type: 'info',
            key: '__homecom-code-help',
            label: HOMECOM_CODE_HELP,
            labelKey: 'provider-bosch:homecom.s_account.__homecom-code-help.label',
            content: '',
          },
          {
            type: 'account-sign-in',
            addonId: 'bosch-homecom',
            key: '__homecom-sign-in',
            label: 'HomeCom',
            labelKey: 'provider-bosch:homecom.s_account.__homecom-sign-in.label',
            providerLabel: 'SingleKey ID',
            beginAction: 'beginSignIn',
            completeAction: 'finishSignIn',
            signOutAction: 'signOut',
            accountKey: 'accountLabel',
            countKey: 'gatewayCount',
            countNoun: 'gateway',
            choiceKey: 'gatewayId',
            choiceLabel: 'Gateway',
            pastePlaceholder: 'com.bosch.tt.dashtt.pointt://app/login?code=…&state=…',
            secretKeys: ['token', 'refresh', 'username'],
            assignResult: {
              token: 'token',
              refresh: 'refresh',
              username: 'username',
              accountLabel: 'accountLabel',
              gatewayId: 'gatewayId',
              brand: 'brand',
              region: 'region',
              gatewayCount: 'gatewayCount',
            },
          },
          {
            type: 'text',
            key: 'accountLabel',
            label: 'Account',
            labelKey: 'provider-bosch:homecom.s_account.accountLabel.label',
            required: false,
            showWhen: HIDDEN_UNTIL_ADVANCED,
          },
          {
            type: 'number',
            key: 'gatewayCount',
            label: 'Gateways',
            labelKey: 'provider-bosch:homecom.s_account.gatewayCount.label',
            required: false,
            showWhen: HIDDEN_UNTIL_ADVANCED,
          },
          {
            type: 'password',
            key: 'username',
            label: 'Account email',
            labelKey: 'provider-bosch:homecom.s_account.username.label',
            required: false,
            showWhen: HIDDEN_UNTIL_ADVANCED,
          },
          {
            type: 'group',
            key: '__homecom-advanced',
            label: 'Advanced',
            labelKey: 'provider-bosch:homecom.s_account.__homecom-advanced.label',
            style: 'accordion',
            defaultCollapsed: true,
            fields: [
              {
                type: 'password',
                key: 'token',
                label: 'Access token',
                labelKey: 'provider-bosch:homecom.s_account.token.label',
                required: false,
                showToggle: false,
              },
              {
                type: 'password',
                key: 'refresh',
                label: 'Refresh token',
                labelKey: 'provider-bosch:homecom.s_account.refresh.label',
                required: false,
                showToggle: false,
              },
              {
                type: 'text',
                key: 'gatewayId',
                label: 'Gateway id',
                labelKey: 'provider-bosch:homecom.s_account.gatewayId.label',
                description:
                  'Filled from the account. Type one only when you need to override the choice.',
                descriptionKey: 'provider-bosch:homecom.s_account.gatewayId.description',
                required: false,
              },
              {
                type: 'select',
                key: 'brand',
                label: 'Brand',
                labelKey: 'provider-bosch:homecom.s_account.brand.label',
                default: 'bosch',
                options: HOMECOM_BRANDS.map((b) => ({ value: b, label: b })),
              },
              {
                type: 'select',
                key: 'region',
                label: 'Region',
                labelKey: 'provider-bosch:homecom.s_account.region.label',
                default: 'eu',
                options: HOMECOM_REGIONS.map((r) => ({
                  value: r,
                  label: r.toUpperCase(),
                })),
              },
            ],
          },
        ],
      },
    ],
  }
}
