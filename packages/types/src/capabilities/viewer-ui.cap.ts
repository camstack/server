import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

const StaticDirOutputSchema = z.object({ staticDir: z.string() })
const VersionOutputSchema = z.object({ version: z.string() })

/**
 * viewer-ui — serves the CamStack VIEWER web build (the Expo/React-Native
 * universal client's PWA export) from the hub, alongside admin-ui. Mirrors
 * `admin-ui` exactly: a singleton, server-internal cap exposing the static
 * dist directory + build version so `main.ts` can mount the SPA under a
 * dedicated prefix.
 */
export const viewerUiCapability = {
  name: 'viewer-ui',
  scope: 'system',
  mode: 'singleton',
  internal: true,
  methods: {
    /**
     * `internal: true` did not gate the mount (see the 2026-08-26 note on
     * `data-store-provider`) — both methods were reachable on the AppRouter
     * by ANY authenticated session at the default `auth: 'protected'`, and
     * `getStaticDir` leaks a hub filesystem path.
     *
     * ⚠ Checked before gating: the VIEWER app IS used by a non-admin user
     * (`bob`), but it never calls `viewerUi.*` over tRPC. The static SPA
     * it loads is served by the plain `GET /viewer/*` Fastify route in
     * `main.ts`, which reads `staticDir`/`indexPath` from a module-level
     * cache populated ONCE at boot via `capRegistry.getSingletonForNode`
     * (in-process, not tRPC) — the cap's tRPC procedure is never on that
     * request path. `auth: 'admin'` here does not block a single viewer
     * user from loading the app.
     */
    getStaticDir: method(z.void(), StaticDirOutputSchema, { auth: 'admin' }),
    getVersion: method(z.void(), VersionOutputSchema, { auth: 'admin' }),
  },
} as const satisfies CapabilityDefinition

export type IViewerUiProvider = InferProvider<typeof viewerUiCapability>
