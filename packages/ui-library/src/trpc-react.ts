/**
 * Shared typed React Query proxy for the backend AppRouter.
 *
 * The proxy is exposed on `window.__camstackTrpcReact` so addon-page
 * bundles (which load AFTER the host admin-ui sets the global) reuse
 * the host's `createTRPCReact` instance instead of creating a separate
 * one. Sharing the instance is mandatory because the typed React-Query
 * hooks read from a Context registered inside the proxy — a duplicate
 * proxy would have its own Context, miss the host's `<trpc.Provider>`
 * tree, and crash with "trpc client not found" on first render.
 *
 * Boot order:
 *   1. admin-ui's `main.tsx` is the first script to evaluate this
 *      module, sees `window.__camstackTrpcReact === undefined`,
 *      creates the proxy, stashes it on the window.
 *   2. Addon bundles are loaded later by `AddonPageLoader` — when
 *      their entrypoint evaluates this same module (resolved through
 *      Vite alias to ui-library/src), the global is already set, so
 *      they pick up the host instance and skip the second create.
 */
import { createTRPCReact, type CreateTRPCReact } from '@trpc/react-query'
import type { AppRouter } from '@camstack/types'

export type AppTrpcReact = CreateTRPCReact<AppRouter, unknown>

declare global {
  // eslint-disable-next-line no-var
  var __camstackTrpcReact: AppTrpcReact | undefined
}

const existing: AppTrpcReact | undefined =
  typeof globalThis !== 'undefined' ? globalThis.__camstackTrpcReact : undefined

export const trpc: AppTrpcReact = existing ?? createTRPCReact<AppRouter>()

if (typeof globalThis !== 'undefined' && !existing) {
  globalThis.__camstackTrpcReact = trpc
}
