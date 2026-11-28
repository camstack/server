/**
 * Re-export of the shared `@dominevo/ui-library` typed React-Query
 * proxy.
 *
 * Phase 2 of the API consolidation moved the WS client construction
 * out of admin-ui — `<AppShell>` now seeds `<trpc.Provider>` directly
 * with the `system.trpcClient` reference owned by the unified
 * `System` SDK class. This module is kept around as a compatibility
 * surface (every call site still imports `{ trpc } from './trpc'`).
 */
import { trpc } from '@dominevo/ui-library'

export { trpc }
