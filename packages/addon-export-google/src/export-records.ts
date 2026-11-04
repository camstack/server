/**
 * What the Google export exposes, as a record (planning#408 P4): ONE `google-exports` record per
 * instance id (`export-google` today) holds the devices Google syncs and the actions it sees as
 * scenes. The addon is its only writer; the in-memory copy it loads at boot is what every
 * fulfillment intent reads.
 */
import { type DefinedRecordKind, defineEntryKind } from '@camstack/types'
import { z } from 'zod'
import type { ActionSceneEntry } from './action-scenes.js'
import type { ExposedDeviceEntry, LinkedAccount } from './types.js'

/**
 * The id the first Google Home instance keeps: the one every record and every pasted fulfillment
 * URL was created under. New instances get minted ids; the legacy `/fulfillment` route answers
 * for this one.
 */
export const GOOGLE_INSTANCE_ID = 'export-google'

export type GoogleExportsBody = {
  readonly name: string
  readonly devices: readonly ExposedDeviceEntry[]
  readonly actions: readonly ActionSceneEntry[]
}

export const ExposedDeviceEntrySchema: z.ZodType<ExposedDeviceEntry> = z.object({
  deviceId: z.number(),
  exposedAt: z.number(),
})

export const ActionSceneEntrySchema: z.ZodType<ActionSceneEntry> = z.object({
  actionId: z.string(),
  displayName: z.string(),
  addedAt: z.number(),
})

export const GoogleExportsBodySchema: z.ZodType<GoogleExportsBody> = z.object({
  name: z.string().min(1),
  devices: z.array(ExposedDeviceEntrySchema),
  actions: z.array(ActionSceneEntrySchema),
})

export const GOOGLE_EXPORTS_KIND_NAME = 'google-exports'

export const GOOGLE_EXPORTS_NAME = 'Google exposure'

export const googleExportsKind: DefinedRecordKind<z.ZodType<GoogleExportsBody>> = defineEntryKind(
  GOOGLE_EXPORTS_KIND_NAME,
  {
    title: 'Google exposure',
    nameField: 'name',
    schema: GoogleExportsBodySchema,
  },
)

export const EMPTY_GOOGLE_EXPORTS: GoogleExportsBody = {
  name: GOOGLE_EXPORTS_NAME,
  devices: [],
  actions: [],
}

/** The settings keys that moved into the record; the migrations name them. */
export const MOVED_EXPOSURE_KEYS = ['exposed', 'exposedActions'] as const

/** The `google-homes` record: one row per Google Home instance (an Actions-console project). */
export type GoogleHomeBody = {
  readonly name: string
  /** Absent means on. */
  readonly enabled?: boolean | undefined
}

export const GoogleHomeBodySchema: z.ZodType<GoogleHomeBody> = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
})

export const GOOGLE_HOMES_KIND_NAME = 'google-homes'
export const GOOGLE_HOME_NAME = 'Google Home'

export const googleHomesKind: DefinedRecordKind<z.ZodType<GoogleHomeBody>> = defineEntryKind(
  GOOGLE_HOMES_KIND_NAME,
  {
    title: 'Google Home instances',
    nameField: 'name',
    schema: GoogleHomeBodySchema,
  },
)

/**
 * The `google-links` record: ONE row per instance id with the camstack users that completed the
 * link. Not a secret: a link is a user id, a name and a time, never a Google identifier.
 */
export type GoogleLinksBody = {
  readonly name: string
  readonly linkedAccounts: readonly LinkedAccount[]
}

export const LinkedAccountSchema: z.ZodType<LinkedAccount> = z.object({
  userId: z.string(),
  username: z.string(),
  linkedAt: z.number(),
})

export const GoogleLinksBodySchema: z.ZodType<GoogleLinksBody> = z.object({
  name: z.string().min(1),
  linkedAccounts: z.array(LinkedAccountSchema),
})

export const GOOGLE_LINKS_KIND_NAME = 'google-links'
export const GOOGLE_LINKS_NAME = 'Google links'

export const googleLinksKind: DefinedRecordKind<z.ZodType<GoogleLinksBody>> = defineEntryKind(
  GOOGLE_LINKS_KIND_NAME,
  {
    title: 'Google linked accounts',
    nameField: 'name',
    schema: GoogleLinksBodySchema,
  },
)

export const EMPTY_GOOGLE_LINKS: GoogleLinksBody = {
  name: GOOGLE_LINKS_NAME,
  linkedAccounts: [],
}

/** The settings key that moved into the `google-links` record; the migrations name it. */
export const MOVED_LINKS_KEY = 'linkedAccounts'
