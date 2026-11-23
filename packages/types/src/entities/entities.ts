/**
 * The records behind a room, a tag and a site zone (D1089). The id is the record
 * id; the body below is everything else. A name is unique within its kind,
 * compared by `entityNameKey`.
 */
import { z } from 'zod'
import { IconKeySchema } from '../device/icon-catalog.js'
import { TagColorIdSchema, TagNameSchema } from '../tags/tag.js'

export const ROOM_NAME_MAX_LENGTH = 80

export const RoomNameSchema = z.string().trim().min(1).max(ROOM_NAME_MAX_LENGTH)

export const RoomBodySchema = z.object({
  name: RoomNameSchema,
  icon: IconKeySchema.optional(),
  description: z.string().optional(),
  /** The id of the site zone this room belongs to (`zones` record). */
  zoneId: z.string().min(1).optional(),
  colour: TagColorIdSchema.optional(),
  order: z.number().optional(),
})
export type RoomBody = z.infer<typeof RoomBodySchema>

export const RoomSchema = RoomBodySchema.extend({ id: z.string().min(1) })
export type Room = z.infer<typeof RoomSchema>

/** A zone record: name and icon; its rooms are the rooms whose `zoneId` names it. */
export const ZoneBodySchema = z.object({
  name: RoomNameSchema,
  icon: IconKeySchema.optional(),
})
export type ZoneBody = z.infer<typeof ZoneBodySchema>

export const TagBodySchema = z.object({
  name: TagNameSchema,
  colour: TagColorIdSchema.optional(),
  icon: IconKeySchema.optional(),
  description: z.string().optional(),
  order: z.number().optional(),
})
export type TagBody = z.infer<typeof TagBodySchema>

export const TagRecordSchema = TagBodySchema.extend({ id: z.string().min(1) })
export type TagRecord = z.infer<typeof TagRecordSchema>

/** The partial an `update*` call carries: a field left out is kept, `null` clears it. */
export const RoomPatchSchema = z.object({
  name: RoomNameSchema.optional(),
  icon: IconKeySchema.nullable().optional(),
  description: z.string().nullable().optional(),
  zoneId: z.string().min(1).nullable().optional(),
  colour: TagColorIdSchema.nullable().optional(),
  order: z.number().nullable().optional(),
})
export type RoomPatch = z.infer<typeof RoomPatchSchema>

export const TagPatchSchema = z.object({
  name: TagNameSchema.optional(),
  colour: TagColorIdSchema.nullable().optional(),
  icon: IconKeySchema.nullable().optional(),
  description: z.string().nullable().optional(),
  order: z.number().nullable().optional(),
})
export type TagPatch = z.infer<typeof TagPatchSchema>
