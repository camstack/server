/**
 * What the Google export exposes, as a record (planning#408 P4): ONE `google-exports` record per
 * instance id (`export-google` today) holds the devices Google syncs and the actions it sees as
 * scenes. The addon is its only writer; the in-memory copy it loads at boot is what every
 * fulfillment intent reads.
 */
import { type DefinedRecordKind, defineEntryKind } from '@camstack/types'
import { z } from 'zod'
import type { ActionSceneEntry } from './action-scenes.js'
import type { ExposedDeviceEntry } from './types.js'

/** A single-instance addon keeps its records under its own addon id. */
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
  { title: 'Google exposure', nameField: 'name', schema: GoogleExportsBodySchema },
)

export const EMPTY_GOOGLE_EXPORTS: GoogleExportsBody = {
  name: GOOGLE_EXPORTS_NAME,
  devices: [],
  actions: [],
}

/** The settings keys that moved into the record; the migrations name them. */
export const MOVED_EXPOSURE_KEYS = ['exposed', 'exposedActions'] as const
