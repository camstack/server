import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { TemplateKindSchema } from '../template/template-kinds.js'

/**
 * template — the generic store of reusable, named operator data (D963). A
 * record is `{ id, kind, name, payload }`; the kinds (today only `remote`, the
 * button grid of a remote) and the schema each payload must satisfy are
 * declared by the system in `template-kinds.ts`. Nothing here is specific to a
 * kind: the engine validates a payload against its kind's schema and, on a
 * delete, asks the kind's owner whether anything still points at the record.
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
})
export type TemplateRecord = z.infer<typeof TemplateRecordSchema>

export const TEMPLATE_WRITE_REFUSALS = ['invalid-payload', 'not-found'] as const
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

export const TemplateDeleteResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('deleted') }),
  z.object({ status: z.literal('not-found') }),
  z.object({ status: z.literal('in-use'), devices: z.array(TemplateUserSchema).min(1) }),
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
} as const satisfies CapabilityDefinition

export type ITemplateProvider = InferProvider<typeof templateCapability>
