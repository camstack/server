import { BoardKeyFailureReasonSchema, customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

const ServiceArgTypeSchema = z.enum([
  'bool',
  'int',
  'float',
  'string',
  'bool[]',
  'int[]',
  'float[]',
  'string[]',
])

const ServiceArgValueSchema = z.union([
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.boolean()),
  z.array(z.number()),
  z.array(z.string()),
])

/**
 * Operator-facing test surface for a board's own API services (an IR blaster's
 * `send_raw_command`, a script). Admin tier: a service can drive hardware.
 */
const KeyImportReasonSchema = z.union([
  BoardKeyFailureReasonSchema,
  z.enum(['no-source', 'no-match', 'ambiguous', 'store-failed']),
])

const KeyImportResultSchema = z
  .object({
    boardId: z.string(),
    name: z.string(),
    outcome: z.enum(['imported', 'unchanged', 'not-imported']),
    reason: KeyImportReasonSchema.optional(),
    sourceId: z.string().optional(),
  })
  .readonly()

export const espServiceActions = defineCustomActions({
  /**
   * Read the API encryption key of every board from a key source (the ESPHome
   * builder beside Home Assistant) and store it. One result per board, with the
   * reason for each that was not imported. The key never appears in the result.
   */
  importBoardKeys: customAction(
    z.object({ integrationId: z.string().min(1).optional() }),
    z.object({ results: z.array(KeyImportResultSchema).readonly() }),
    { kind: 'mutation', auth: 'admin' },
  ),
  listServices: customAction(
    z.object({ brokerId: z.string().min(1) }),
    z
      .array(
        z
          .object({
            name: z.string(),
            key: z.number(),
            args: z
              .array(z.object({ name: z.string(), type: ServiceArgTypeSchema }).readonly())
              .readonly(),
          })
          .readonly(),
      )
      .readonly(),
    { kind: 'mutation', auth: 'admin' },
  ),
  executeService: customAction(
    z.object({
      brokerId: z.string().min(1),
      name: z.string().min(1),
      args: z.record(z.string(), ServiceArgValueSchema).default({}),
    }),
    z.object({ ok: z.literal(true) }),
    { kind: 'mutation', auth: 'admin' },
  ),
})
