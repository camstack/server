/**
 * Per-node scoping for the shared addon-settings blob.
 *
 * An addon's settings store is hub-central (the `addon-settings` cap is
 * hub-routed — the hub instance answers for every node), so fields whose
 * value is a NODE fact (decoder backend, engine pick, probed hardware
 * capabilities) persist under the node-scoped key `<key>@<nodeId>` inside
 * the single shared blob. The SCHEMA field key stays bare: the write path
 * ({@link scopePatch}) maps the bare field onto the target node's scoped
 * key; the read/hydrate path ({@link projectStore}) maps THIS node's value
 * back, so UI forms and `resolveConfig` only ever see the bare key.
 *
 * Fields opt in via the `perNode: true` schema marker on `ConfigFieldBase`
 * (`interfaces/config-ui.ts`); `BaseAddon` derives the key set from the
 * schema and routes reads/writes through these helpers.
 *
 * ## No bare-key fallback — deliberate
 *
 * {@link readNodeValue} reads the node-scoped key ONLY. A node with no
 * scoped key resolves to `undefined` so the field's schema `default` wins —
 * NEVER `store[base]` and never another node's value. A bare legacy key in
 * the store is invisible to every node, hub included, so one node's
 * selection can never leak onto another. (This generalizes the
 * `decoder-backend-keys.ts` semantics — the no-fallback variant — over an
 * arbitrary set of per-node field keys.)
 *
 * Pure functions only — no I/O, no imports beyond the language. This is a
 * LEAF module: import it via its deep path, never from the root barrel.
 */

/**
 * Normalize a raw kernel node id to the bare node id used for scoping.
 * `localNodeId` can carry a `<node>/<addon>` suffix on forked child
 * processes; per-node settings are per-NODE, so strip the addon segment.
 * `undefined` / `null` / empty falls back to `'hub'`.
 */
export function normalizeNodeId(raw: string | undefined | null): string {
  if (raw === undefined || raw === null || raw === '') return 'hub'
  const slashIdx = raw.indexOf('/')
  if (slashIdx < 0) return raw
  const bare = raw.slice(0, slashIdx)
  return bare === '' ? 'hub' : bare
}

/** The node-scoped store key for a per-node field: `<base>@<nodeId>`. */
export function nodeScopedKey(base: string, nodeId: string): string {
  return `${base}@${normalizeNodeId(nodeId)}`
}

/**
 * Read a node's value for a per-node field from the raw shared store:
 * the node-scoped key when present, otherwise `undefined`.
 * Deliberately NO bare-key fallback (see module doc) — the caller lets the
 * schema `default` win on `undefined`.
 */
export function readNodeValue(
  store: Readonly<Record<string, unknown>>,
  base: string,
  nodeId: string,
): unknown {
  return store[nodeScopedKey(base, nodeId)]
}

/**
 * Re-map a UI/settings patch so every bare perNode field persists under the
 * TARGET node's scoped key; all other keys pass through unchanged. Used on
 * the write path so a save for one node never clobbers another node's value
 * (and the bare key is never written). Returns a new object — the input
 * patch is not mutated.
 */
export function scopePatch(
  patch: Readonly<Record<string, unknown>>,
  perNodeKeys: ReadonlySet<string>,
  nodeId: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    out[perNodeKeys.has(key) ? nodeScopedKey(key, nodeId) : key] = value
  }
  return out
}

/**
 * Project the raw shared store onto the bare schema keys for ONE node so a
 * UI schema (whose field keys are bare) hydrates from that node's own
 * values:
 *
 * - EVERY `@`-scoped key (any node's) is dropped from the pass-through.
 * - Every bare perNode key is dropped from the pass-through (a stray bare
 *   legacy key must never hydrate any node — no bare fallback).
 * - THIS node's effective value ({@link readNodeValue}) is then laid onto
 *   each bare perNode key; when the node has no scoped key the bare key is
 *   left ABSENT so the field's schema `default` wins.
 *
 * Returns a new object — the input store is not mutated.
 */
export function projectStore(
  store: Readonly<Record<string, unknown>>,
  perNodeKeys: ReadonlySet<string>,
  nodeId: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(store)) {
    if (key.includes('@')) continue
    if (perNodeKeys.has(key)) continue
    out[key] = value
  }
  for (const base of perNodeKeys) {
    const value = readNodeValue(store, base, nodeId)
    if (value !== undefined) out[base] = value
  }
  return out
}
