import {
  customAction,
  defineCustomActions,
  isSecretFieldView,
  type SecretFieldView,
} from '@camstack/types'
import { z } from 'zod'
import { HomeComBrandSchema, HomeComRegionSchema } from './config.js'
import {
  EXPLORER_MAX_DEADLINE_MS,
  EXPLORER_MAX_NODES_CAP,
  exploredResourceSchema,
  explorerStopReasonSchema,
  explorerSummarySchema,
  isResourcePath,
} from './homecom-resource-explorer.js'

/** A stored secret as the form sees it (`SecretFieldView`): set or not, never the value. */
const secretView = z.custom<SecretFieldView>(isSecretFieldView, 'a stored secret view')

/**
 * A sign-in secret in the result: in clear only for a form that has no record yet (the wizard
 * stores it on create); for an existing instance it is already stored and comes back as a view.
 */
const signInSecret = z.union([z.string().min(1), secretView, z.null()]).meta({ secret: true })

const gatewayChoice = z.object({
  value: z.string(),
  label: z.string(),
  brand: HomeComBrandSchema,
  region: HomeComRegionSchema,
})

export const exploreResourcesInput = z.object({
  /** The HomeCom integration instance; may be omitted when exactly one is connected. */
  integrationId: z.string().min(1).optional(),
  root: z
    .string()
    .refine(isResourcePath, 'an absolute resource path such as /heatSources, no . or .. segment')
    .optional(),
  maxNodes: z.number().int().min(1).max(EXPLORER_MAX_NODES_CAP).optional(),
  /** Wall-clock budget; the walk returns what it has, with `stoppedBy: 'deadline'`. */
  deadlineMs: z.number().int().min(1000).max(EXPLORER_MAX_DEADLINE_MS).optional(),
})

export type ExploreResourcesInput = z.infer<typeof exploreResourcesInput>

export const exploreResourcesOutput = z.object({
  integrationId: z.string(),
  /** Null when the integration has no snapshot yet: unknown, not empty. */
  gatewayId: z.string().nullable(),
  root: z.string(),
  stoppedBy: explorerStopReasonSchema,
  unvisited: z.number(),
  unvisitedPaths: z.array(z.string()),
  droppedReferences: z.number(),
  droppedSamples: z.array(z.string()),
  summary: explorerSummarySchema,
  resources: z.array(exploredResourceSchema),
})

export type ExploreResourcesOutput = z.infer<typeof exploreResourcesOutput>

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
      /** An existing instance: the new sign-in is stored on it and applied at once. */
      integrationId: z.string().min(1).optional(),
    }),
    z.object({
      token: signInSecret,
      refresh: signInSecret,
      username: z.union([z.string(), secretView, z.null()]).meta({ secret: true }),
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
    /** An existing instance: its stored sign-in is cleared and its connection stopped. */
    z.object({ integrationId: z.string().min(1).optional() }),
    z.object({ signedOut: z.literal(true), summary: z.string() }),
    { kind: 'mutation', auth: 'admin' },
  ),
  /** Read-only walk of the gateway's resource tree, for diagnosing what it serves. */
  exploreResources: customAction(exploreResourcesInput, exploreResourcesOutput, {
    kind: 'query',
    auth: 'admin',
  }),
})

export type HomeComActions = typeof homeComActions
