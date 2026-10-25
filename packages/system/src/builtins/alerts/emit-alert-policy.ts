import type { Alert } from '@camstack/types'

export function episodeKeyFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const key = metadata?.['episodeKey']
  return typeof key === 'string' ? key : undefined
}

export interface EmitMergeInput {
  readonly existing: {
    readonly read?: boolean
    readonly episodeKey?: string
    readonly status?: string
  } | null
  readonly incoming: Alert
}

/**
 * Re-emit of the same alert id: preserve `read` when the episode is unchanged
 * and still active. A completed episode starts again.
 */
export function mergeEmitAlert(input: EmitMergeInput): Alert {
  const incomingKey = episodeKeyFromMetadata(input.incoming.metadata)
  const existingKey = input.existing?.episodeKey

  if (input.existing?.read === true) {
    const sameEpisode = incomingKey === undefined || incomingKey === existingKey
    const priorCompleted = input.existing.status === 'completed'
    if (sameEpisode && !priorCompleted) {
      return { ...input.incoming, read: true }
    }
  }
  return input.incoming
}
