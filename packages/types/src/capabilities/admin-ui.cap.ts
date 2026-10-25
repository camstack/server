import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

const StaticDirOutputSchema = z.object({ staticDir: z.string() })
const VersionOutputSchema = z.object({ version: z.string() })

export const adminUiCapability = {
  name: 'admin-ui',
  scope: 'system',
  mode: 'singleton',
  internal: true,
  methods: {
    /**
     * `internal: true` did not gate the mount (see the 2026-08-26 note on
     * `data-store-provider`) — both methods were reachable on the AppRouter
     * by ANY authenticated session at the default `auth: 'protected'`, and
     * `getStaticDir` leaks a hub filesystem path. The only caller is
     * `main.ts`'s static-file bootstrap, via `capRegistry.getSingletonForNode`
     * — never tRPC — so `auth: 'admin'` costs it nothing. The actual admin-ui
     * SPA assets are served as plain static files, unaffected by this gate.
     */
    getStaticDir: method(z.void(), StaticDirOutputSchema, { auth: 'admin' }),
    getVersion: method(z.void(), VersionOutputSchema, { auth: 'admin' }),
  },
} as const satisfies CapabilityDefinition

export type IAdminUiProvider = InferProvider<typeof adminUiCapability>
