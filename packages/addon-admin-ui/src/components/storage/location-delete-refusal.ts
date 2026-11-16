/**
 * What the hub's refusal of a storage-location delete means. The orchestrator throws plain
 * messages (no typed code travels through the generic `deleteInstance` call), so the two
 * occupancy refusals are recognised here, narrowly and in this one place; any other error is
 * not a refusal the operator may override.
 */
export type DeleteRefusal = 'holds-data' | 'unverifiable'

export function classifyDeleteRefusal(err: unknown): DeleteRefusal | null {
  const message = err instanceof Error ? err.message : String(err)
  if (/still holds data — drain it first/.test(message)) return 'holds-data'
  if (/could not be checked for remaining data/.test(message)) return 'unverifiable'
  return null
}
