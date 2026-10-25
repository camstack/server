/**
 * Standard props for addon page components.
 *
 * Every addon page receives these props from the AddonPageLoader in admin-ui.
 * Use this type for your page's default export:
 *
 * ```tsx
 * import type { AddonPageProps } from '@camstack/ui'
 * import { trpc } from '@camstack/ui-library'
 *
 * export default function MyAddonPage({ theme }: AddonPageProps) {
 *   // Typed React-Query hooks via the shared proxy.
 *   const { data } = trpc.system.health.useQuery()
 *   return <pre>{JSON.stringify(data)}</pre>
 * }
 * ```
 *
 * The `trpc` prop is the vanilla SDK client (BackendClient.trpc) and
 * remains available for non-React contexts. Inside React components
 * prefer the typed `trpc.X.useQuery / useMutation / useSubscription`
 * hooks imported from `@camstack/ui-library` — they share the same
 * QueryClient + WS client as the host admin-ui and therefore play nice
 * with cache invalidation, suspense, and the rest of React Query.
 */
import type { TRPCClient } from '@trpc/client'
import type { AppRouter } from '@camstack/types'

export interface AddonPageProps {
  /**
   * Vanilla tRPC client — fully typed access for non-React call sites.
   *
   * It is a tree of Proxies over FUNCTION targets: every level answers
   * `typeof x === 'function'`, and `'query' in x` is always `false`. A page
   * that validates it at runtime checks that the leaf it calls is callable
   * (`typeof … === 'function'`) and names the missing path on failure — an
   * `typeof x === 'object'` / `in` check refuses the real client.
   */
  readonly trpc: TRPCClient<AppRouter>
  /** Current theme state */
  readonly theme: { readonly isDark: boolean }
  /** Navigate to a route within the admin UI */
  readonly navigate: (path: string) => void
}
