/**
 * UDS child log ingest helpers — Task B2.
 *
 * Pure mapping function shared by the hub (`MoleculerService`) and the agent
 * (`agent-bootstrap`) to convert a `ChildLogMessage` received over a UDS
 * channel into the `writeFromWorker` / `log-receiver.ingest` entry shape.
 *
 * Kept in `@camstack/kernel` so both the hub (server/backend) and the agent
 * (`packages/agent`) can import it without cross-package coupling.
 *
 * The shape produced mirrors the existing `$hub.log` / `onLog` mapping in
 * `moleculer.service.ts` exactly — optional keys (`scope`, `tags`, `meta`)
 * are omitted rather than set to `undefined` so callers never receive stray
 * keys in spread operations.
 */
import type { LogTags } from '@camstack/types'
import type { ChildLogMessage } from './child-cap-protocol.js'

/**
 * The entry shape accepted by `LoggingService.writeFromWorker` (hub) and by
 * the agent's `log-receiver.ingest` Moleculer forwarding call.
 *
 * Typed here so the helper has no dependency on hub-only server classes.
 */
export interface WorkerLogEntry {
  readonly addonId: string
  readonly nodeId?: string
  readonly level: string
  readonly message: string
  readonly scope?: string
  readonly tags?: LogTags
  readonly meta?: Record<string, unknown>
}

/**
 * Convert a `ChildLogMessage` received over a UDS channel into the
 * `WorkerLogEntry` shape.
 *
 * - `childId` is used as the `nodeId` fallback when the child did not include
 *   its own `nodeId` in the log entry (pre-B2 runners or very early boot logs).
 * - The entry's `addonId` is preserved as-is — it identifies the actual addon
 *   that emitted the log, not the runner that forwarded it. Child identity is
 *   fully preserved so the admin-UI log stream shows the originating addon.
 */
export function udsChildLogToWorkerEntry(childId: string, entry: ChildLogMessage): WorkerLogEntry {
  return {
    addonId: entry.addonId,
    nodeId: entry.nodeId ?? childId,
    level: entry.level,
    message: entry.message,
    ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
    ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
    ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
  }
}
