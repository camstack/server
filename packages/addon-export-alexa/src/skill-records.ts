/**
 * The Alexa export as an integration instance (D985, D996): ONE `skills` record, owned by
 * `export-alexa` and named after it, holds how the skill reaches this hub and what each exposed
 * camera carries. The two ledgers of the link (`linkedAccounts`, `tokens`) are a second record,
 * `skill-links`, under the SAME id: the instance they belong to. The tokens' credentials are
 * keychain markers bound to that row, matched by user id so a reorder keeps every ref.
 */
import { CamProfileSchema, type DefinedRecordKind, defineEntryKind } from '@camstack/types'
import { z } from 'zod'
import type { ActionSceneEntry } from './action-scenes.js'
import type { StoredVisibilityMap } from './access/account-visibility.js'
import type { StoredDetectionClasses } from './detection-sensors/detection-classes.js'
import { DETECTION_SENSOR_CLASSES } from './handlers/endpoint-id.js'
import type {
  ExportDeviceSettings,
  ExposedDeviceEntry,
  LinkedAccount,
  LwaTokenEntry,
} from './types.js'

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

export const LinkedAccountSchema: z.ZodType<LinkedAccount> = z.object({
  userId: z.string(),
  username: z.string(),
  linkedAt: z.number(),
})

export const LwaTokenEntrySchema: z.ZodType<LwaTokenEntry> = z.object({
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

/** The exposure keys that moved into the `skill-exports` record; the migrations name them. */
export const MOVED_EXPOSURE_KEYS = ['exposed', 'exposedActions'] as const

/**
 * What the skill exposes, under the SAME id as the instance it belongs to: the devices Alexa
 * discovers and the actions it sees as scenes. One record per instance id (`export-alexa`
 * today), so a second skill gets its own membership.
 */
export type SkillExportsBody = {
  readonly name: string
  readonly devices: readonly ExposedDeviceEntry[]
  readonly actions: readonly ActionSceneEntry[]
}

const ExportDeviceSettingsSchema: z.ZodType<ExportDeviceSettings> = z.object({
  streamPreference: z.string(),
  sourceProfile: CamProfileSchema.optional(),
  allowTranscode: z.boolean().optional(),
})

export const ExposedDeviceEntrySchema: z.ZodType<ExposedDeviceEntry> = z.object({
  deviceId: z.number(),
  exposedAt: z.number(),
  settings: ExportDeviceSettingsSchema.optional(),
})

export const ActionSceneEntrySchema: z.ZodType<ActionSceneEntry> = z.object({
  actionId: z.string(),
  displayName: z.string(),
  addedAt: z.number(),
})

export const SkillExportsBodySchema: z.ZodType<SkillExportsBody> = z.object({
  name: z.string().min(1),
  devices: z.array(ExposedDeviceEntrySchema),
  actions: z.array(ActionSceneEntrySchema),
})

export const SKILL_EXPORTS_KIND_NAME = 'skill-exports'

export const SKILL_EXPORTS_NAME = 'Alexa exposure'

export const alexaSkillExportsKind: DefinedRecordKind<z.ZodType<SkillExportsBody>> =
  defineEntryKind(SKILL_EXPORTS_KIND_NAME, {
    title: 'Alexa exposure',
    nameField: 'name',
    schema: SkillExportsBodySchema,
  })

export const EMPTY_SKILL_EXPORTS: SkillExportsBody = {
  name: SKILL_EXPORTS_NAME,
  devices: [],
  actions: [],
}

/** The settings keys that moved into the `skill-state` record; the migrations name them. */
export const MOVED_STATE_KEYS = [
  'ingressToken',
  'visionNamespace',
  'detectionClasses',
  'accountVisibility',
  'exportedEndpoints',
  'exportedSignatures',
  'advertisedBrokerUrl',
  'lwaClientId',
] as const

/**
 * What ONE skill told Alexa and what its Lambda holds, under the instance's id: the ingress
 * token its Lambda presents (a credential, kept in the keychain), the namespace its object
 * identifiers derive under, and the mirrors of what Alexa was last sent. Maps keyed by device id
 * are keyed by the id's text (a record is JSON).
 */
export type SkillStateBody = {
  readonly name: string
  /** Absent until first generated; the keychain holds it. */
  readonly ingressToken?: string | undefined
  readonly visionNamespace: string
  readonly detectionClasses: Readonly<Record<string, StoredDetectionClasses>>
  readonly accountVisibility: StoredVisibilityMap
  readonly exportedEndpoints: Readonly<Record<string, readonly string[]>>
  readonly exportedSignatures: Readonly<Record<string, string>>
  readonly advertisedBrokerUrl: string
  readonly lwaClientId: string
}

const DetectionClassEnum = z.enum(DETECTION_SENSOR_CLASSES)

export const StoredDetectionClassesSchema: z.ZodType<StoredDetectionClasses> = z.object({
  classes: z.array(DetectionClassEnum),
  missingSince: z.partialRecord(DetectionClassEnum, z.number()).optional(),
})

export const StoredVisibilitySchema: z.ZodType<StoredVisibilityMap[string]> = z.union([
  z.object({ all: z.literal(true) }),
  z.object({
    all: z.literal(false).optional(),
    view: z.array(z.number()),
    pendingRemoval: z.array(z.number()).optional(),
  }),
])

export const DetectionClassesMapSchema = z.record(z.string(), StoredDetectionClassesSchema)
export const AccountVisibilityMapSchema = z.record(z.string(), StoredVisibilitySchema)
export const ExportedEndpointsMapSchema = z.record(z.string(), z.array(z.string()))
export const ExportedSignaturesMapSchema = z.record(z.string(), z.string())

export const SkillStateBodySchema: z.ZodType<SkillStateBody> = z.object({
  name: z.string().min(1),
  ingressToken: z.string().optional().meta({ secret: true }),
  visionNamespace: z.string(),
  detectionClasses: DetectionClassesMapSchema,
  accountVisibility: AccountVisibilityMapSchema,
  exportedEndpoints: ExportedEndpointsMapSchema,
  exportedSignatures: ExportedSignaturesMapSchema,
  advertisedBrokerUrl: z.string(),
  lwaClientId: z.string(),
})

export const SKILL_STATE_KIND_NAME = 'skill-state'

export const SKILL_STATE_NAME = 'Alexa skill state'

export const alexaSkillStateKind: DefinedRecordKind<z.ZodType<SkillStateBody>> = defineEntryKind(
  SKILL_STATE_KIND_NAME,
  { title: 'Alexa skill state', nameField: 'name', schema: SkillStateBodySchema },
)

/** What a skill's state starts as, before a token and a namespace are generated. */
export const EMPTY_SKILL_STATE: SkillStateBody = {
  name: SKILL_STATE_NAME,
  visionNamespace: '',
  detectionClasses: {},
  accountVisibility: {},
  exportedEndpoints: {},
  exportedSignatures: {},
  advertisedBrokerUrl: '',
  lwaClientId: '',
}

/** A device-keyed map as the record keeps it: the id's text is the key. */
export function keyedByText<T>(map: Readonly<Record<number, T>>): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(map))
}
