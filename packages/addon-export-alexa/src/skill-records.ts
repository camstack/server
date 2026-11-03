/**
 * The Alexa export as an integration instance (D985, D996): ONE `skills` record, owned by
 * `export-alexa` and named after it, holds how the skill reaches this hub and what each exposed
 * camera carries. The two ledgers of the link (`linkedAccounts`, `tokens`) are a second record,
 * `skill-links`, under the SAME id: the instance they belong to. The tokens' credentials are
 * keychain markers bound to that row, matched by user id so a reorder keeps every ref.
 */
import { type DefinedRecordKind, defineEntryKind } from '@camstack/types'
import { z } from 'zod'
import type { LinkedAccount, LwaTokenEntry } from './types.js'

/** A single-instance addon keeps its records under its own addon id. */
export const ALEXA_INSTANCE_ID = 'export-alexa'

export type AlexaSkillMode = 'public' | 'custom'
export type AlexaSkillRegion = 'NA' | 'EU' | 'FE'

export type AlexaSkillBody = {
  readonly name: string
  readonly skillMode: AlexaSkillMode
  readonly region: AlexaSkillRegion
  readonly expectedAudience: string
  readonly detectionSensors: boolean
  readonly objectDetection: boolean
  readonly snapshots: boolean
  readonly enforceIngressToken: boolean
  /** The instance's own switch (D996). Absent means on. */
  readonly enabled?: boolean | undefined
}

/** The schema is checked against the interface by its annotation: a drifted field fails the typecheck. */
export const AlexaSkillBodySchema: z.ZodType<AlexaSkillBody> = z.object({
  name: z.string().min(1),
  skillMode: z.enum(['public', 'custom']),
  region: z.enum(['NA', 'EU', 'FE']),
  expectedAudience: z.string(),
  detectionSensors: z.boolean(),
  objectDetection: z.boolean(),
  snapshots: z.boolean(),
  enforceIngressToken: z.boolean(),
  enabled: z.boolean().optional(),
})

export const SKILLS_KIND_NAME = 'skills'

export const alexaSkillsKind: DefinedRecordKind<z.ZodType<AlexaSkillBody>> = defineEntryKind(
  SKILLS_KIND_NAME,
  { title: 'Alexa skill', nameField: 'name', schema: AlexaSkillBodySchema },
)

/** What a skill starts as: the defaults the addon's constructor used to carry. */
export const ALEXA_SKILL_DEFAULT_BODY: Omit<AlexaSkillBody, 'name'> = {
  skillMode: 'public',
  region: 'NA',
  expectedAudience: '',
  detectionSensors: true,
  objectDetection: true,
  snapshots: true,
  enforceIngressToken: false,
}

/** The settings keys that moved into the `skills` record; the migrations name them. */
export const MOVED_SKILL_KEYS = [
  'skillMode',
  'region',
  'expectedAudience',
  'detectionSensors',
  'objectDetection',
  'snapshots',
  'enforceIngressToken',
] as const

/** The ledger keys that moved into the `skill-links` record. */
export const MOVED_LEDGER_KEYS = ['linkedAccounts', 'tokens'] as const

export type SkillLinksBody = {
  readonly name: string
  readonly linkedAccounts: readonly LinkedAccount[]
  readonly tokens: readonly LwaTokenEntry[]
}

const LinkedAccountSchema: z.ZodType<LinkedAccount> = z.object({
  userId: z.string(),
  username: z.string(),
  linkedAt: z.number(),
})

const LwaTokenEntrySchema: z.ZodType<LwaTokenEntry> = z.object({
  userId: z.string(),
  accessToken: z.string().meta({ secret: true }),
  expiresAt: z.number(),
  receivedAt: z.number(),
  refreshToken: z.string().optional().meta({ secret: true }),
  brokerUrl: z.string().optional(),
  brokerCredential: z.string().optional().meta({ secret: true }),
})

export const SkillLinksBodySchema: z.ZodType<SkillLinksBody> = z.object({
  name: z.string().min(1),
  linkedAccounts: z.array(LinkedAccountSchema),
  tokens: z.array(LwaTokenEntrySchema),
})

export const SKILL_LINKS_KIND_NAME = 'skill-links'

export const alexaSkillLinksKind: DefinedRecordKind<z.ZodType<SkillLinksBody>> = defineEntryKind(
  SKILL_LINKS_KIND_NAME,
  {
    title: 'Alexa account links',
    nameField: 'name',
    schema: SkillLinksBodySchema,
    secretArrayKeys: { tokens: 'userId' },
  },
)
