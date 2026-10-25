/**
 * The automatic benchmark's attempt ledger as it is stored: a nested
 * `nodeId → deviceKey → { count, lastAtMs }` blob (JSON object keys cannot
 * carry the in-memory `nodeId\0deviceKey` separator safely), converted to and
 * from the scheduler's flat map. Pure.
 */
import type { AutoBenchmarkAttemptsBlob } from '../orchestrator-store-schemas.js'
import type { AutoBenchAttempt } from './auto-benchmark.js'

export function attemptsToBlob(
  attempts: ReadonlyMap<string, AutoBenchAttempt>,
): AutoBenchmarkAttemptsBlob {
  const out: Record<string, Record<string, AutoBenchAttempt>> = {}
  for (const [key, attempt] of attempts) {
    const sep = key.indexOf('\u0000')
    if (sep < 0) continue
    const nodeId = key.slice(0, sep)
    out[nodeId] = { ...out[nodeId], [key.slice(sep + 1)]: attempt }
  }
  return out
}

export function attemptsFromBlob(
  blob: AutoBenchmarkAttemptsBlob,
  keyOf: (nodeId: string, deviceKey: string) => string,
): ReadonlyMap<string, AutoBenchAttempt> {
  const out = new Map<string, AutoBenchAttempt>()
  for (const [nodeId, devices] of Object.entries(blob)) {
    for (const [deviceKey, attempt] of Object.entries(devices)) {
      out.set(keyOf(nodeId, deviceKey), { count: attempt.count, lastAtMs: attempt.lastAtMs })
    }
  }
  return out
}
