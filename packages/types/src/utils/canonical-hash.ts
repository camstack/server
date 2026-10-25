import { createHash } from 'node:crypto'

/**
 * Deterministic SHA-256 hash of an arbitrary serialisable value. The
 * canonical form sorts object keys alphabetically at every depth so two
 * structurally-equal inputs with different key insertion orders produce
 * the same hash. Returns a 64-char lowercase hex digest.
 *
 * Used by export adapters (Alexa, HAP) to short-circuit re-discovery /
 * accessory-rebuild work when the upstream shape is byte-identical to
 * the last applied state — preventing user-visible "re-discovery"
 * notifications on every addon-runner respawn. Each respawn re-fires
 * `DeviceBindingsChanged` for every cap registration, which without
 * this guard would propagate redundant pushes.
 *
 * Note: this is a SYMPTOMATIC fix layered on top of the binding-change
 * subscription. The proper fix is a single "device ready" lifecycle
 * barrier so exports react only when the full cap set has landed —
 * tracked separately for post-HA-integration work.
 */
export function canonicalHash(value: unknown): string {
  const canonical = JSON.stringify(value, replaceWithSortedKeys)
  return createHash('sha256')
    .update(canonical ?? '')
    .digest('hex')
}

function replaceWithSortedKeys(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj).toSorted()) out[k] = obj[k]
    return out
  }
  return value
}
