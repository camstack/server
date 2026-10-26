import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

export const boschShcActions = defineCustomActions({
  discoverController: customAction(
    z.object({}),
    z.object({
      hosts: z.array(z.object({ host: z.string(), name: z.string(), id: z.string() })),
      summary: z.string(),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
  registerClient: customAction(
    z.object({
      host: z.string().optional(),
      hostManual: z.string().optional(),
      systemPassword: z.string().min(1),
    }),
    z.object({
      sslCertificate: z.string().min(1).meta({ secret: true }),
      sslKey: z.string().min(1).meta({ secret: true }),
      token: z.string().min(1).meta({ secret: true }),
      summary: z.string(),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
})

export type BoschShcActions = typeof boschShcActions
