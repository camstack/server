/**
 * Pure validator for the persisted `role` setting written by the setup window.
 *
 * The value comes from `electron-store` (untyped JSON on disk) so it must be
 * validated before it drives a process spawn — or, for `'viewer'`, before it
 * SUPPRESSES one and drops the `ignore-certificate-errors` switch. Only the
 * exact strings `'agent'` and `'viewer'` select those roles; ANY other value —
 * a legacy store with no `role` key, a typo, corrupt JSON, `undefined` — falls
 * back to `'hub'` (the default, matching `@camstack/server`'s `resolveNodeRole`,
 * where an empty `CAMSTACK_ROLE` is a hub). Kept dependency-free for unit
 * testing.
 */
import type { NodeRole } from './types'

export function parseRoleSetting(value: unknown): NodeRole {
  if (value === 'agent') return 'agent'
  if (value === 'viewer') return 'viewer'
  return 'hub'
}
