/**
 * The sources of a remote (planning#460): what a media player's source list
 * offers, ALWAYS declared by the operator — a button is never a source on its
 * own. Two kinds:
 *
 *  - `digits`: a name and a number ("Rai 1" = `1`, "Canale 24" = `25`). The
 *    steps are the number's `digit_N` roles, so the number is also the channel
 *    a voice command or `playMedia` names.
 *  - `sequence`: a name and explicit steps — bound roles pressed in order
 *    (an input key, a menu macro such as `source, down, down, ok`).
 *
 * The name and the number resolve to the SAME declared source. A number no
 * `digits` source declares is not a channel: it is refused, never guessed.
 */
import { z } from 'zod'
import { RemoteRoleSchema } from './remote-roles.js'

export const REMOTE_SOURCE_KINDS = ['digits', 'sequence'] as const
export const RemoteSourceKindSchema = z.enum(REMOTE_SOURCE_KINDS)
export type RemoteSourceKind = z.infer<typeof RemoteSourceKindSchema>

export const MAX_REMOTE_SOURCES = 200
export const MAX_REMOTE_SOURCE_STEPS = 16
export const MAX_REMOTE_CHANNEL_DIGITS = 6

const REMOTE_SOURCE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/
const CHANNEL_NUMBER_RE = new RegExp(`^[0-9]{1,${MAX_REMOTE_CHANNEL_DIGITS}}$`)

const sourceBase = {
  /** A lowercase slug, stable across renames. */
  id: z.string().regex(REMOTE_SOURCE_ID_RE, { message: 'a lowercase slug' }),
  /** What the operator calls it, and what a voice command or a picker names. */
  name: z.string().trim().min(1).max(60),
}

export const RemoteDigitsSourceSchema = z.object({
  ...sourceBase,
  kind: z.literal('digits'),
  number: z.string().regex(CHANNEL_NUMBER_RE, { message: 'up to 6 digits' }),
})
export type RemoteDigitsSource = z.infer<typeof RemoteDigitsSourceSchema>

export const RemoteSequenceSourceSchema = z.object({
  ...sourceBase,
  kind: z.literal('sequence'),
  steps: z.array(RemoteRoleSchema).min(1).max(MAX_REMOTE_SOURCE_STEPS),
})
export type RemoteSequenceSource = z.infer<typeof RemoteSequenceSourceSchema>

export const RemoteSourceSchema = z.discriminatedUnion('kind', [
  RemoteDigitsSourceSchema,
  RemoteSequenceSourceSchema,
])
export type RemoteSource = z.infer<typeof RemoteSourceSchema>

/** The `stepDelayMs` bounds: a property of the television's receiver, not a repeat count. */
export const REMOTE_STEP_DELAY_DEFAULT_MS = 500
export const REMOTE_STEP_DELAY_MIN_MS = 100
export const REMOTE_STEP_DELAY_MAX_MS = 3000

/** The roles a source presses, in order. A `digits` number is its digit roles. */
export function remoteSourceSteps(source: RemoteSource): readonly string[] {
  return source.kind === 'sequence'
    ? source.steps
    : Array.from(source.number, (digit) => `digit_${digit}`)
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** The `digits` source that declares this channel number, or null. */
export function findChannelSource(
  sources: readonly RemoteSource[],
  number: string,
): RemoteDigitsSource | null {
  const wanted = number.trim()
  for (const source of sources) {
    if (source.kind === 'digits' && source.number === wanted) return source
  }
  return null
}

/**
 * The declared source a name, an id or a channel number points at. The name and
 * the number reach the same source; nothing else is guessed.
 */
export function resolveRemoteSource(
  sources: readonly RemoteSource[],
  query: string,
): RemoteSource | null {
  const byName = sources.find((source) => same(source.name, query))
  if (byName !== undefined) return byName
  const byId = sources.find((source) => source.id === query.trim())
  if (byId !== undefined) return byId
  return findChannelSource(sources, query)
}
