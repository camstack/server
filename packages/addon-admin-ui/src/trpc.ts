/**
 * Re-export of the shared `@camstack/ui-library` typed React-Query
 * proxy.
 *
 * Phase 2 of the API consolidation moved the WS client construction
 * out of admin-ui — `<AppShell>` now seeds `<trpc.Provider>` directly
 * with the `system.trpcClient` reference owned by the unified
 * `System` SDK class. This module is kept around as a compatibility
 * surface (every call site still imports `{ trpc } from './trpc'`).
 */
import { trpc } from '@camstack/ui-library'

export { trpc }
