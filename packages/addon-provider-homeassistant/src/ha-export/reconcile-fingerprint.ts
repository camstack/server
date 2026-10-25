/**
 * Structure fingerprint for the reconcile short-circuit.
 *
 * A flapping camera (RTSP retry every 4 s emits a device event per attempt)
 * was driving a full announce + state push every ~13 s, forever, through the
 * event-debounced 'structure-changed' path. The fingerprint captures the
 * ANNOUNCED shape — device keys, broker membership, the whole plan — and
 * nothing stateful, so an identical rebuild can skip the announce. Only the
 * 'structure-changed' reason may skip: 'boot', 'periodic' and config-driven
 * passes always announce (D8/D11 — events are an optimisation over the
 * periodic pass, never a substitute).
 */

interface FingerprintableEntry {
  readonly brokerIds: readonly string[]
  readonly plan: unknown
}

export function structureFingerprint(exported: ReadonlyMap<string, FingerprintableEntry>): string {
  return JSON.stringify(
    [...exported.keys()].sort().map((key) => {
      const entry = exported.get(key)
      return [key, entry?.brokerIds, entry?.plan]
    }),
  )
}

/** Only an event-debounced pass with an unchanged structure may skip. */
export function shouldSkipAnnounce(
  reason: string,
  fingerprint: string,
  lastFingerprint: string | undefined,
): boolean {
  return reason === 'structure-changed' && fingerprint === lastFingerprint
}
