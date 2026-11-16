import { z } from 'zod'
import { IconKeySchema } from '../device/icon-catalog.js'
import { TagColorIdSchema, TagNameSchema } from '../tags/tag.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * tags — the registry of tag STYLES and the one place that renames or removes a
 * tag everywhere (D1054). A tag itself lives in the `tags` array of the record it
 * labels (a core block, a scheduler, a template, an action, a device, a
 * notification rule); only its
 * colour token and icon are registered here. Provided by the core-blocks builtin,
 * the one place that knows every owner kind; devices and notification rules
 * are reached through `deviceManager` / `notificationRules` over `ctx.api`.
 *
 * Tags compare trimmed and case-insensitively. `list` is the union of styled tags
 * and tags in use; a tag with no style answers a colour derived from its name and
 * the default icon (`styled: false`).
 */

export const TagUsageCountsSchema = z.object({
  coreBlocks: z.number().int().nonnegative(),
  schedulers: z.number().int().nonnegative(),
  templates: z.number().int().nonnegative(),
  actions: z.number().int().nonnegative(),
  devices: z.number().int().nonnegative(),
  notificationRules: z.number().int().nonnegative(),
})
export type TagUsageCounts = z.infer<typeof TagUsageCountsSchema>

/**
 * The counts `list` answers. An owner that could not be read (a forked addon
 * that is down, redeploying or not installed) is `null` — unknown, never `0`
 * (D393) — and `list` still answers with the other owners' tags.
 */
export const TagListCountsSchema = z.object({
  coreBlocks: z.number().int().nonnegative().nullable(),
  schedulers: z.number().int().nonnegative().nullable(),
  templates: z.number().int().nonnegative().nullable(),
  actions: z.number().int().nonnegative().nullable(),
  devices: z.number().int().nonnegative().nullable(),
  notificationRules: z.number().int().nonnegative().nullable(),
})
export type TagListCounts = z.infer<typeof TagListCountsSchema>

export const TagEntrySchema = z.object({
  name: TagNameSchema,
  color: TagColorIdSchema,
  icon: IconKeySchema,
  /** `false` when the operator never chose a style: colour and icon are the derived defaults. */
  styled: z.boolean(),
  /** Per owner kind; `null` = that owner could not be read on this call. */
  counts: TagListCountsSchema,
})
export type TagEntry = z.infer<typeof TagEntrySchema>

export const tagsCapability = {
  name: 'tags',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /**
     * Every tag: styled or in use, with how many records of each kind carry it.
     * An unreachable owner degrades that kind's count to `null`; the call still
     * answers.
     */
    list: method(z.object({}), z.array(TagEntrySchema), { auth: 'protected' }),
    /** Choose the colour and icon of a tag. The tag need not be in use. */
    setStyle: method(
      z.object({ name: TagNameSchema, color: TagColorIdSchema, icon: IconKeySchema }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Rename a tag on EVERY owner in one call. When `to` already exists the two
     * merge and the TARGET's style wins (like `renameLocation`). An empty `to`
     * is refused before anything is written, and so is any call while an owner
     * cannot be read (the error names the owner): a rename applied to
     * only some owners would split the fleet across two spellings.
     */
    rename: method(
      z.object({ from: z.string(), to: z.string() }),
      z.object({ updated: TagUsageCountsSchema }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Drop a tag from every owner and delete its style. Refused like `rename` while an owner cannot be read. */
    remove: method(z.object({ name: z.string() }), z.object({ updated: TagUsageCountsSchema }), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
  vocabulary: {
    notOperatorFacing: 'tags are managed from the tag picker and the tags manager, not actuated',
  },
} as const satisfies CapabilityDefinition

export type ITagsProvider = InferProvider<typeof tagsCapability>
