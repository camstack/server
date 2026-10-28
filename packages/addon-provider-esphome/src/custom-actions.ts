import { customAction, defineCustomActions } from '@camstack/types'
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
export const espServiceActions = defineCustomActions({
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
