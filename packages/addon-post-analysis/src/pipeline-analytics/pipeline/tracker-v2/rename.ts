/**
 * Moving per-track state from an absorbed id to its survivor (D683 §6.2).
 * The absorbed piece is the LIVE continuation, so its entry replaces
 * whatever the survivor had (the survivor's own piece already ended).
 */
export function renameKey<K, V>(map: Map<K, V>, from: K, to: K): void {
  if (!map.has(from)) return
  const value = map.get(from)
  map.delete(from)
  if (value !== undefined) map.set(to, value)
}

export function renameMember<K>(set: Set<K>, from: K, to: K): void {
  if (!set.delete(from)) return
  set.add(to)
}
