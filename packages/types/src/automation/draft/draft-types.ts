/**
 * Entity drafting — the shared shapes.
 *
 * A "draft" is what a language model proposes for a description ("when the
 * doorbell rings, turn on the porch light"): one of four entity kinds, written
 * against a SLICE of the site's vocabulary (the devices, caps, fields, actions
 * and zones the description is about). Everything here is pure: no model call,
 * no hub, no clock. The caller supplies the site.
 */
import { z } from 'zod'

export const DRAFT_KINDS = ['automation', 'action', 'scheduler', 'composition'] as const
export const DraftKindSchema = z.enum(DRAFT_KINDS)
export type DraftKind = z.infer<typeof DraftKindSchema>

/** One device the drafter may reference, as the site reports it. */
export const DraftSiteDeviceSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string().min(1),
  /** A `DeviceType` value. */
  type: z.string().min(1),
  room: z.string().min(1).nullable(),
  addonId: z.string().min(1),
  stableId: z.string().min(1),
  /** The device-scope caps it serves (vocabulary names). */
  caps: z.array(z.string().min(1)),
  /** Camera zones, by name. */
  zones: z.array(z.string().min(1)).optional(),
})
export type DraftSiteDevice = z.infer<typeof DraftSiteDeviceSchema>

export const DraftSiteSchema = z.object({
  timeZone: z.string().min(1),
  location: z.object({ latitude: z.number(), longitude: z.number() }).nullable(),
  rooms: z.array(z.string().min(1)),
  devices: z.array(DraftSiteDeviceSchema).min(1),
  /** Existing internal actions a step may call (`internal:<uuid>`). */
  actions: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).default([]),
})
export type DraftSite = z.infer<typeof DraftSiteSchema>

export type DraftFieldKind = 'boolean' | 'number' | 'enum' | 'value'

export interface SliceField {
  readonly path: string
  readonly kind: DraftFieldKind
  readonly label: string
  readonly values?: readonly string[]
}

export interface SliceOpenArg {
  readonly key: string
  readonly kind: 'number' | 'enum' | 'text' | 'boolean' | 'dynamic'
  readonly min?: number
  readonly max?: number
  readonly values?: readonly (string | number)[]
  readonly optional: boolean
}

export interface SliceAction {
  readonly id: string
  readonly cap: string
  readonly method: string
  readonly phrase: string
  readonly args: Readonly<Record<string, unknown>>
  readonly openArgs: readonly SliceOpenArg[]
}

export interface SliceCap {
  readonly cap: string
  readonly noun: string
  readonly fields: readonly SliceField[]
  readonly actions: readonly SliceAction[]
  readonly categories: readonly string[]
}

export interface SliceDevice {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly room: string | null
  readonly addonId: string
  readonly stableId: string
  readonly caps: readonly string[]
  readonly zones: readonly string[]
  readonly score: number
}

/** The part of the site one description is about. Deterministic for a (site, description). */
export interface VocabularySlice {
  readonly rooms: readonly string[]
  readonly devices: readonly SliceDevice[]
  readonly caps: readonly SliceCap[]
  readonly zones: readonly string[]
  readonly eventCategories: readonly string[]
  readonly internalActions: readonly { readonly id: string; readonly name: string }[]
  readonly deviceTypes: readonly string[]
  readonly timeZone: string
  /** The slice as prompt lines, at most {@link SLICE_MAX_LINES}. */
  readonly lines: readonly string[]
}

export const SLICE_MAX_LINES = 60

/** A caps-and-fields line item of a composition target the drafter may build. */
export interface CompositionTargetCap {
  readonly cap: string
  readonly required: readonly string[]
  readonly fields: readonly string[]
}

export interface DraftFewShot {
  readonly description: string
  readonly entity: unknown
}

export type DraftValidation =
  | { readonly ok: true; readonly draft: unknown }
  | { readonly ok: false; readonly issues: readonly string[] }

export type JsonSchemaValue =
  | string
  | number
  | boolean
  | null
  | JsonSchema
  | readonly JsonSchemaValue[]
export interface JsonSchema {
  readonly [key: string]: JsonSchemaValue
}
