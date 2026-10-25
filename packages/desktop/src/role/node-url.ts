/**
 * The LOCAL node's ports and window URL — the two roles that actually spawn a
 * child. Extracted from `main.ts` so the setup window can name the same ports
 * without importing the shell, and so the mapping is unit-testable.
 *
 * The viewer role is deliberately absent from `nodeUrl`: it has no local node
 * and its URL comes from the configured hub (`hub-pin-store.ts`). The type
 * makes that a compile error rather than a wrong port.
 */
import type { NodeRole } from '../types'

/** A role that spawns and supervises a node child. */
export type SupervisedRole = Exclude<NodeRole, 'viewer'>

/** Agent role: local HTTP status/UI port (server default is 4444). */
export const AGENT_LOCAL_PORT = 4444
/** Hub role: packaged server serves the admin UI over HTTPS on this port. */
export const HUB_PROD_PORT = 4443
/** Hub role, dev: admin-ui runs out-of-process on the Vite dev server. */
export const HUB_DEV_URL = 'https://localhost:3001'

/** True when this role runs a node child of its own. */
export function isSupervisedRole(role: NodeRole): role is SupervisedRole {
  return role !== 'viewer'
}

/** The embedded window URL for a supervised role. */
export function nodeUrl(role: SupervisedRole, isPackaged: boolean): string {
  if (role === 'agent') return `http://localhost:${AGENT_LOCAL_PORT}/`
  return isPackaged ? `https://localhost:${HUB_PROD_PORT}/` : HUB_DEV_URL
}
