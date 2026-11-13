import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { TemplateKindSchema } from '../template/template-kinds.js'

/**
 * template — the generic store of reusable, named operator data (D963). A
 * record is `{ id, kind, name, payload }`; the kinds (today only `remote`, the
 * button grid of a remote) and the schema each payload must satisfy are
 * declared by the system in `template-kinds.ts`. Nothing here is specific to a
 * kind: the engine validates a payload against its kind's schema and, on a
 * delete, asks the kind's owner whether anything still points at the record
 * (a device's remote, an automation made from the template). Saving an
 * `automation` template re-expands every automation made from it (#527).
 *
 * Every refusal is a typed result — a UI says "unknown kind" or names the
 * devices that still use a template, without parsing text.
 */

export const TemplateRecordSchema = z.object({
  id: z.string().min(1),
  kind: TemplateKindSchema,
  name: z.string().min(1).max(120),
  /** Shaped by the kind; `checkTemplatePayload(kind, payload)` reads it. */
  payload: z.unknown(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Shipped with CamStack (`builtin:` ids): listed beside the operator's, never updated or deleted. */
  builtIn: z.literal(true).optional(),
})
export type TemplateRecord = z.infer<typeof TemplateRecordSchema>

export const TEMPLATE_WRITE_REFUSALS = ['invalid-payload', 'not-found', 'read-only'] as const
export const TemplateWriteResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved'), template: TemplateRecordSchema }),
  z.object({
    status: z.literal('refused'),
    reason: z.enum(TEMPLATE_WRITE_REFUSALS),
    detail: z.string(),
  }),
])
export type TemplateWriteResult = z.infer<typeof TemplateWriteResultSchema>

/** A device still pointing at a template. */
export const TemplateUserSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  name: z.string(),
})
export type TemplateUser = z.infer<typeof TemplateUserSchema>

/** An automation made from a template (#527): a core block whose recipe links to it. */
export const TemplateAutomationUserSchema = z.object({
  blockId: z.string().min(1),
  name: z.string(),
})
export type TemplateAutomationUser = z.infer<typeof TemplateAutomationUserSchema>

export const TemplateDeleteResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('deleted') }),
  z.object({ status: z.literal('not-found') }),
  /** A built-in template: shipped with CamStack, never deleted. */
  z.object({ status: z.literal('read-only') }),
  /** At least one of the two lists is non-empty. */
  z.object({
    status: z.literal('in-use'),
    devices: z.array(TemplateUserSchema),
    automations: z.array(TemplateAutomationUserSchema),
  }),
])
export type TemplateDeleteResult = z.infer<typeof TemplateDeleteResultSchema>

export const templateCapability = {
  name: 'template',
  scope: 'system',
  mode: 'collection',
  methods: {
    list: method(z.object({ kind: TemplateKindSchema.optional() }), z.array(TemplateRecordSchema), {
      auth: 'protected',
    }),
    get: method(z.object({ id: z.string().min(1) }), TemplateRecordSchema.nullable(), {
      auth: 'protected',
    }),
    create: method(
      z.object({
        kind: TemplateKindSchema,
        name: z.string().min(1).max(120),
        payload: z.unknown(),
      }),
      TemplateWriteResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    update: method(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1).max(120).optional(),
        payload: z.unknown().optional(),
      }),
      TemplateWriteResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    delete: method(z.object({ id: z.string().min(1) }), TemplateDeleteResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
  vocabulary: {
    notOperatorFacing: 'operator-authored templates — edited in their own editor, never actuated',
  },
} as const satisfies CapabilityDefinition

export type ITemplateProvider = InferProvider<typeof templateCapability>
