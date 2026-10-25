/**
 * Is a stored value still pointed at? — the orphan check behind System →
 * Secrets.
 *
 * A ref says where its marker lives (owner + scope), so the check reads THAT
 * blob and looks for `{"$secret": ref}` anywhere in it. Three answers, and the
 * third is the important one: `unknown` when the blob could not be read, or
 * when the scope's store is not one this check knows how to read. A read that
 * did not answer is never "orphan" — and only an orphan can be deleted from
 * the page (D315: absence is claimed only from a query that answered).
 */
import { type KeychainSecretUsage, parseSecretRef, type SecretScope } from '@camstack/types'
import type { KeychainDoor, KeychainSecretRow } from './keychain-store.js'
import {
  PROCESS_HELD_SECRET_REFS,
  SYSTEM_SECRET_OWNER,
  SYSTEM_SECRET_SETTINGS_KEYS,
} from './system-held-secrets.js'

type Blob = unknown

/** Every `$secret` ref inside a value, at any depth. */
export function collectMarkerRefs(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectMarkerRefs(item, out)
    return out
  }
  if (value === null || typeof value !== 'object') {
    // Integration settings are serialized TEXT; a JSON string may hold markers.
    if (typeof value === 'string' && value.includes('"$secret"')) {
      try {
        collectMarkerRefs(JSON.parse(value), out)
      } catch {
        /* not JSON — no markers */
      }
    }
    return out
  }
  const ref: unknown = Reflect.get(value, '$secret')
  if (typeof ref === 'string') out.add(ref)
  for (const child of Object.values(value)) collectMarkerRefs(child, out)
  return out
}

/** Rows under an ASCII id prefix, one bounded page; `null` when the page filled. */
async function prefixRows(
  door: KeychainDoor,
  collection: string,
  prefix: string,
): Promise<readonly Blob[] | null> {
  const hi = `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`
  const LIMIT = 2_000
  const rows = await door.query({
    collection,
    filter: { whereBetween: { id: [prefix, hi] }, limit: LIMIT },
  })
  if (rows.length >= LIMIT) return null
  return rows.filter((r) => r.id.startsWith(prefix)).map((r) => r.data)
}

/** The blobs that may hold the marker of a ref in `scope`; `null` = cannot tell. */
async function blobsFor(
  door: KeychainDoor,
  owner: string,
  scope: SecretScope,
): Promise<readonly Blob[] | null> {
  if (owner === SYSTEM_SECRET_OWNER && scope.kind === 'global') {
    // The hub's own secrets (D797): a process-held ref counts as pointed at;
    // a form-owned one's marker sits in its `system-settings` row.
    const held = [...PROCESS_HELD_SECRET_REFS].map((ref) => ({ $secret: ref, v: 1 }))
    const rows = await Promise.all(
      SYSTEM_SECRET_SETTINGS_KEYS.map((key) => door.get({ collection: 'system-settings', key })),
    )
    return [held, ...rows]
  }
  switch (scope.kind) {
    case 'global':
    case 'node': {
      // ONE row per key (`addon-settings` `<addonId>.<key>`) for every process
      // (D870). The per-addon BLOB is still read - until the migration's drop
      // removes it - so a secret only an old blob points at (between deploy and
      // copy) is "in use", not an orphan someone could delete. A read of a table
      // nobody wrote answers absent and creates nothing.
      const legacyBlob = await door.get({
        namespace: owner,
        collection: 'addon-settings',
        key: 'root',
      })
      const rows = await prefixRows(door, 'addon-settings', `${owner}.`)
      return rows === null ? null : [legacyBlob, ...rows]
    }
    case 'device': {
      // ONE store for every process (D870): the owner's own per-device rows, and
      // device-manager's, which keep a device's connection config.
      const legacyBlob = await door.get({
        namespace: owner,
        collection: 'addon-devices',
        key: String(scope.deviceId),
      })
      const own = await prefixRows(door, 'addon-device-settings', `${owner}:${scope.deviceId}.`)
      const connection =
        owner === 'device-manager'
          ? []
          : await prefixRows(door, 'addon-device-settings', `device-manager:${scope.deviceId}.`)
      if (own === null || connection === null) return null
      return [legacyBlob, ...own, ...connection]
    }
    case 'integration': {
      const rows = await door.query({
        collection: 'integration_settings',
        filter: { where: { integration_id: scope.integrationId }, limit: 2_000 },
      })
      return rows.map((r) => r.data)
    }
    case 'row':
      return [await door.get({ collection: scope.collection, key: scope.rowId })]
  }
}

/** Build the usage check the service uses. */
export function createKeychainUsageCheck(door: KeychainDoor) {
  return async (
    rows: readonly KeychainSecretRow[],
  ): Promise<ReadonlyMap<string, KeychainSecretUsage>> => {
    const out = new Map<string, KeychainSecretUsage>()
    // One read per (owner, scope), however many refs share it.
    const groups = new Map<string, { owner: string; scope: SecretScope; refs: string[] }>()
    for (const row of rows) {
      const parts = parseSecretRef(row.ref)
      if (parts === null) {
        out.set(row.ref, 'unknown')
        continue
      }
      const key = `${parts.owner}|${row.scope}`
      const group = groups.get(key) ?? { owner: parts.owner, scope: parts.scope, refs: [] }
      group.refs.push(row.ref)
      groups.set(key, group)
    }
    for (const group of groups.values()) {
      let blobs: readonly Blob[] | null
      try {
        blobs = await blobsFor(door, group.owner, group.scope)
      } catch {
        blobs = null
      }
      if (blobs === null) {
        for (const ref of group.refs) out.set(ref, 'unknown')
        continue
      }
      const seen = new Set<string>()
      for (const blob of blobs) collectMarkerRefs(blob, seen)
      for (const ref of group.refs) out.set(ref, seen.has(ref) ? 'in-use' : 'orphan')
    }
    return out
  }
}
