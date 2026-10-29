/**
 * A remote layout COMPONENT (D973): a reusable, named chunk of a remote — a
 * D-pad, a keypad, a section divider — offered in the template editor's
 * "Add component" palette. Pure data: the buttons are placed RELATIVE to the
 * component, and the frame, shape and tone are names from the closed
 * vocabularies the UI draws. An addon contributes components through the
 * `remote-layout-components` cap and ships no UI code.
 */
import { z } from 'zod'
import {
  MAX_LAYOUT_SPAN,
  RemoteButtonShapeSchema,
  RemoteButtonToneSchema,
  RemoteGroupFrameSchema,
  rectsOverlap,
} from './remote-config.js'
import { RemoteRoleSchema } from './remote-roles.js'

export const REMOTE_COMPONENT_CATEGORIES = [
  'power',
  'navigation',
  'volume',
  'numbers',
  'media',
  'colour',
  'apps',
  'layout',
] as const
export const RemoteComponentCategorySchema = z.enum(REMOTE_COMPONENT_CATEGORIES)
export type RemoteComponentCategory = z.infer<typeof RemoteComponentCategorySchema>

export const MAX_COMPONENT_BUTTONS = 40

/** `<namespace>:<name>`, both lowercase slugs — `core:dpad`, `<addonId>:<name>`. */
const COMPONENT_ID_RE = /^[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_-]*$/
const SUFFIX_RE = /^[a-z0-9][a-z0-9_-]{0,19}$/

export const RemoteComponentButtonSchema = z.object({
  /** Joined to the instance id when the component is inserted. */
  idSuffix: z.string().regex(SUFFIX_RE, { message: 'a short lowercase slug' }),
  row: z.number().int().min(0).max(MAX_LAYOUT_SPAN),
  col: z.number().int().min(0).max(MAX_LAYOUT_SPAN),
  rowSpan: z.number().int().min(1).max(MAX_LAYOUT_SPAN),
  colSpan: z.number().int().min(1).max(MAX_LAYOUT_SPAN),
  role: RemoteRoleSchema,
  icon: z.string().min(1).max(60).optional(),
  label: z.string().min(1).max(40).optional(),
  shape: RemoteButtonShapeSchema.optional(),
  tone: RemoteButtonToneSchema.optional(),
})
export type RemoteComponentButton = z.infer<typeof RemoteComponentButtonSchema>

export const RemoteLayoutComponentSchema = z
  .object({
    id: z.string().max(80).regex(COMPONENT_ID_RE, { message: '<namespace>:<name>, lowercase' }),
    name: z.string().min(1).max(60),
    nameI18n: z.object({ en: z.string().min(1).max(60), it: z.string().min(1).max(60) }).optional(),
    /** A display icon key, resolved by the UI like a button icon. */
    icon: z.string().min(1).max(60),
    category: RemoteComponentCategorySchema,
    size: z.object({
      rows: z.number().int().min(1).max(MAX_LAYOUT_SPAN),
      cols: z.number().int().min(1).max(MAX_LAYOUT_SPAN),
    }),
    /** The frame drawn around the whole component, or null for loose buttons. */
    group: z
      .object({ frame: RemoteGroupFrameSchema, title: z.string().min(1).max(40).optional() })
      .nullable(),
    buttons: z.array(RemoteComponentButtonSchema).max(MAX_COMPONENT_BUTTONS),
  })
  .superRefine((component, ctx) => {
    const suffixes = new Set<string>()
    component.buttons.forEach((button, index) => {
      if (suffixes.has(button.idSuffix)) {
        ctx.addIssue({
          code: 'custom',
          message: `button "${button.idSuffix}" is listed twice`,
          path: ['buttons', index, 'idSuffix'],
        })
      }
      suffixes.add(button.idSuffix)
      if (
        button.row + button.rowSpan > component.size.rows ||
        button.col + button.colSpan > component.size.cols
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `button "${button.idSuffix}" leaves the component`,
          path: ['buttons', index],
        })
        return
      }
      for (let other = 0; other < index; other += 1) {
        const earlier = component.buttons[other]
        if (earlier !== undefined && rectsOverlap(earlier, button)) {
          ctx.addIssue({
            code: 'custom',
            message: `buttons "${earlier.idSuffix}" and "${button.idSuffix}" overlap`,
            path: ['buttons', index],
          })
          return
        }
      }
    })
    if (component.group?.frame === 'divider' && component.buttons.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'a divider component holds no buttons',
        path: ['buttons'],
      })
    }
  })
export type RemoteLayoutComponent = z.infer<typeof RemoteLayoutComponentSchema>
