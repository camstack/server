import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'
import { HomeComBrandSchema, HomeComRegionSchema } from './config.js'

const gatewayChoice = z.object({
  value: z.string(),
  label: z.string(),
  brand: HomeComBrandSchema,
  region: HomeComRegionSchema,
})

export const homeComActions = defineCustomActions({
  beginSignIn: customAction(
    z.object({}),
    z.object({
      attemptId: z.string().min(1),
      authorizeUrl: z.string().min(1),
      summary: z.string(),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
  finishSignIn: customAction(
    z.object({
      attemptId: z.string().min(1),
      callback: z.string().min(1),
    }),
    z.object({
      token: z.string().min(1).meta({ secret: true }),
      refresh: z.string().min(1).meta({ secret: true }),
      username: z.string().meta({ secret: true }),
      accountLabel: z.string(),
      gatewayCount: z.number(),
      summary: z.string(),
      gatewayId: z.string().optional(),
      brand: HomeComBrandSchema.optional(),
      region: HomeComRegionSchema.optional(),
      choices: z.array(gatewayChoice).optional(),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
  signOut: customAction(
    z.object({}),
    z.object({ signedOut: z.literal(true), summary: z.string() }),
    { kind: 'mutation', auth: 'admin' },
  ),
})

export type HomeComActions = typeof homeComActions
