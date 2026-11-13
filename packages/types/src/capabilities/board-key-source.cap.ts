import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { NOT_A_DEVICE } from '../device/cap-vocabulary/system-reasons.js'

/**
 * Why a board key could not be read. Typed so a caller reports the cause and
 * never treats "could not read" as "has no key" (D49).
 */
export const BoardKeyFailureReasonSchema = z.enum([
  'unknown-source',
  'not-admin',
  'no-builder',
  'no-ingress-url',
  'unreachable',
  'unknown-board',
  'no-encryption-key',
  'unreadable-config',
])
export type BoardKeyFailureReason = z.infer<typeof BoardKeyFailureReasonSchema>

const BoardKeySourceSchema = z.object({
  sourceId: z.string(),
  name: z.string(),
})

const BoardKeyBoardSchema = z.object({
  /** The builder's file name, e.g. `kitchen.yaml`: the handle `getBoardKey` takes. */
  configuration: z.string(),
  /** The node name the builder gives the board. */
  name: z.string(),
  /** The address the builder knows the board by, when it has one. */
  address: z.string().nullable(),
})

const BoardKeyFailureSchema = z.object({
  ok: z.literal(false),
  reason: BoardKeyFailureReasonSchema,
  detail: z.string().optional(),
})

const ListBoardsResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    boards: z.array(BoardKeyBoardSchema).readonly(),
  }),
  BoardKeyFailureSchema,
])

const GetBoardKeyResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), key: z.string() }),
  BoardKeyFailureSchema,
])

export type BoardKeySource = z.infer<typeof BoardKeySourceSchema>
export type BoardKeyBoard = z.infer<typeof BoardKeyBoardSchema>
export type BoardKeyListResult = z.infer<typeof ListBoardsResultSchema>
export type BoardKeyResult = z.infer<typeof GetBoardKeyResultSchema>

/**
 * Where a device board's API encryption key can be read from (the ESPHome
 * builder that runs beside a Home Assistant). Admin only: `getBoardKey`
 * returns a credential, and nothing else the source holds ever crosses.
 */
export const boardKeySourceCapability = {
  name: 'board-key-source',
  scope: 'system',
  mode: 'collection',
  methods: {
    listSources: method(z.void(), z.array(BoardKeySourceSchema).readonly(), {
      auth: 'admin',
    }),
    listBoards: method(z.object({ sourceId: z.string().min(1) }), ListBoardsResultSchema, {
      auth: 'admin',
    }),
    getBoardKey: method(
      z.object({
        sourceId: z.string().min(1),
        configuration: z.string().min(1),
      }),
      GetBoardKeyResultSchema,
      { auth: 'admin' },
    ),
  },
  vocabulary: { notOperatorFacing: NOT_A_DEVICE.INTERNAL },
} as const satisfies CapabilityDefinition
export type IBoardKeySourceProvider = InferProvider<typeof boardKeySourceCapability>
