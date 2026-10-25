import { defineEntryKind } from '@camstack/types'
import { z } from 'zod'

export const OIDC_PROVIDER_OWNER = 'auth'
export const OIDC_PROVIDER_KIND = 'oidc-provider'

const usernameClaimSchema = z.enum(['preferred_username', 'email', 'sub'])

export const OidcProviderBodySchema = z.object({
  displayName: z.string().min(1),
  icon: z.string(),
  issuerUrl: z.string(),
  clientId: z.string(),
  clientSecret: z.string().meta({ secret: true }),
  redirectUri: z.string(),
  scopes: z.string(),
  usernameClaim: usernameClaimSchema,
})
export type OidcProviderBody = z.infer<typeof OidcProviderBodySchema>

export const oidcProviderEntryKind = defineEntryKind(OIDC_PROVIDER_KIND, {
  title: 'OIDC providers',
  nameField: 'displayName',
  schema: OidcProviderBodySchema,
  writeTrigger: 'an operator adds, edits or removes an OpenID Connect identity provider',
})
