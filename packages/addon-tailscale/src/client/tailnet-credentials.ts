/**
 * Which pre-auth key and hostname the client joins with. The tailnet instance is the source; the
 * node settings (`authKey`, `hostname`) answer only while no instance exists, i.e. before the
 * `authkey-to-instance` migration has run on this hub. Once a record exists the node settings are
 * never consulted again, so a stale leftover cannot out-vote what the operator saved.
 */
import type { ResolvedInstance } from '@camstack/types'
import type { TailnetBody } from './tailnet-record-kinds.js'

export interface TailnetCredentials {
  readonly authKey: string
  readonly hostname: string
}

export function effectiveCredentials(
  record: ResolvedInstance<TailnetBody> | null,
  settings: TailnetCredentials,
): TailnetCredentials {
  if (record === null) return settings
  // A switched-off instance joins nothing silently; a locked keychain serves no key (the caller
  // keeps what it had rather than act on an empty one, D49) — both read as "no key to rejoin with".
  const usable = record.enabled && record.secrets === 'resolved'
  return {
    authKey: usable ? (record.body.authKey ?? '') : '',
    hostname: record.body.hostname,
  }
}
