import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'

/**
 * Kia Connect regions the worker accepts: the standard European cloud and the CCI one some
 * newer European cars use. The operator-supplied value is validated at the system boundary.
 */
export const KIA_REGIONS = ['europe', 'europe-cci'] as const
export const KiaRegionSchema = z.enum(KIA_REGIONS)
export type KiaRegionValue = z.infer<typeof KiaRegionSchema>

/** The maker brands the same cloud library serves. Kia is the default. */
export const KIA_BRANDS = ['kia', 'hyundai', 'genesis'] as const
export const KiaBrandSchema = z.enum(KIA_BRANDS)
export type KiaBrandValue = z.infer<typeof KiaBrandSchema>

/**
 * The account of ONE Kia integration: the app username and password, the security PIN the
 * maker app asks before a remote command, and the cloud it lives in. The password and the PIN
 * are secrets by type: the keychain holds them, the worker gets them in its stdin login line.
 */
export const kiaConfigSchema = z.object({
  username: z.string().min(1).describe('Kia Connect account username'),
  password: z.string().min(1).describe('Kia Connect account password').meta({ secret: true }),
  pin: z.string().min(1).describe('Kia Connect security PIN').meta({ secret: true }),
  region: KiaRegionSchema.default('europe').describe('Kia cloud region'),
  brand: KiaBrandSchema.default('kia').describe('Vehicle brand'),
})
export type KiaConfig = z.infer<typeof kiaConfigSchema>

/** Parse an integration's settings into a connection, or null when a credential is missing. */
export function connectionFromSettings(settings: Record<string, unknown>): KiaConfig | null {
  const parsed = kiaConfigSchema.safeParse(settings)
  return parsed.success ? parsed.data : null
}

/** The "Add Kia account" form of the integration instances provider. */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'credentials',
        title: 'Kia Connect account',
        titleKey: 'provider-kia:connection.s_credentials.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'username',
            label: 'Username',
            labelKey: 'provider-kia:connection.s_credentials.username.label',
            required: true,
            placeholder: 'you@example.com',
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-kia:connection.s_credentials.password.label',
            required: true,
            showToggle: true,
          },
          {
            type: 'password',
            key: 'pin',
            label: 'Security PIN',
            labelKey: 'provider-kia:connection.s_credentials.pin.label',
            required: true,
            showToggle: true,
          },
        ],
      },
      {
        id: 'cloud',
        title: 'Cloud',
        titleKey: 'provider-kia:connection.s_cloud.title',
        columns: 2,
        fields: [
          {
            type: 'select',
            key: 'region',
            label: 'Region',
            labelKey: 'provider-kia:connection.s_cloud.region.label',
            default: 'europe',
            options: [
              { value: 'europe', label: 'Europe' },
              { value: 'europe-cci', label: 'Europe (CCI)' },
            ],
          },
          {
            type: 'select',
            key: 'brand',
            label: 'Brand',
            labelKey: 'provider-kia:connection.s_cloud.brand.label',
            default: 'kia',
            options: [
              { value: 'kia', label: 'Kia' },
              { value: 'hyundai', label: 'Hyundai' },
              { value: 'genesis', label: 'Genesis' },
            ],
          },
        ],
      },
    ],
  }
}
