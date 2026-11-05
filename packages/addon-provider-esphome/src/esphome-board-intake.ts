/**
 * How a board enters an integration, from either way the operator offers it: the
 * manual "Enter parameters" form, or a board found on the network (which asks for
 * its key only when it announced encryption). Both end in one saved board row
 * and one container; this module is the step in between.
 *
 * The key is asked for ONLY by an encrypted board. When the operator left it
 * empty the key sources are asked first; a board that needs a key and has none
 * is refused with the place to find it, never added to fail silently.
 */
import { type EspBoardCreation } from './config.js'
import type { BoardKeyLookup } from './esphome-key-import.js'

export interface BoardIntakeDeps {
  /** The integration the board goes to; throws when `named` is absent and there is not exactly one. */
  readonly resolveIntegration: (named: unknown) => Promise<string>
  /** Read a board's key from the key sources (the ESPHome Builder beside Home Assistant). */
  readonly lookupKey: (board: {
    readonly name: string
    readonly host: string
  }) => Promise<BoardKeyLookup>
  /** Save the board in the integration (idempotent on host and port). */
  readonly addBoard: (
    integrationId: string,
    input: {
      readonly host: string
      readonly port: number
      readonly name: string
      readonly encryptionKey: string
      readonly password: string
    },
  ) => Promise<{ readonly id: string; readonly name: string }>
}

export interface BoardIntakeInput {
  /** The integration the operator is adding to; absent only when it has exactly one ESPHome integration. */
  readonly integrationId?: unknown
  readonly board: EspBoardCreation
  /** The board announced encryption: an empty key is a refusal, not an unencrypted board. */
  readonly keyRequired: boolean
}

export interface BoardIntakeResult {
  readonly integrationId: string
  readonly board: { readonly id: string; readonly name: string }
}

export const ESPHOME_KEY_REQUIRED_MESSAGE =
  'This board is encrypted: enter its API encryption key. It is in the board YAML under api: encryption: key:.'

export async function intakeBoard(
  deps: BoardIntakeDeps,
  input: BoardIntakeInput,
): Promise<BoardIntakeResult> {
  const integrationId = await deps.resolveIntegration(input.integrationId)
  const { board } = input
  let encryptionKey = board.encryptionKey.trim()
  if (encryptionKey.length === 0 && board.password.length === 0) {
    const looked = await deps.lookupKey({ name: board.name, host: board.host })
    if (looked.outcome === 'found') encryptionKey = looked.key
  }
  if (input.keyRequired && encryptionKey.length === 0) {
    throw new Error(ESPHOME_KEY_REQUIRED_MESSAGE)
  }
  const saved = await deps.addBoard(integrationId, {
    host: board.host,
    port: board.port,
    name: board.name,
    encryptionKey,
    password: board.password,
  })
  return { integrationId, board: saved }
}
