/**
 * Node-id normalisation for the detection pipeline.
 *
 * The legacy per-node engine CASCADE keys (`engineBackend` / `engineDevice` /
 * `probedBestEngine`) were removed together with the operator-facing engine
 * election: each node now runs a device-array of inference pools balanced
 * per-session, and the node-default pool is derived live from the node's own
 * hardware (`resolveAutoEngine`). All that survives from the old cascade module
 * is the node-id normaliser, still used to target the platform-probe per node.
 */

/**
 * Normalise a raw kernel node id to the bare node id. `localNodeId` can carry a
 * `<node>/<addon>` suffix; probe targeting is per-NODE, so strip the addon
 * segment. Falls back to `hub`.
 */
export function normalizeEngineNodeId(rawNodeId: string | undefined | null): string {
  const raw = rawNodeId ?? 'hub'
  return raw.includes('/') ? (raw.split('/')[0] ?? 'hub') : raw
}
