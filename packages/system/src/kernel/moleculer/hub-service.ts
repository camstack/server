import type { ServiceSchema, Context } from 'moleculer'
import type { LogTags } from '@camstack/types'
import type { RegisterNodeParams, RegisterNodeResult } from './node-registry.js'
import type { MeshIdentityGate } from './mesh-identity.js'

interface HubServiceDeps {
  readonly getAddonConfig: (addonId: string) => unknown
  readonly getSettings: (scope: string, key?: string) => unknown
  readonly getRecentEvents: (category?: string, limit?: number) => readonly unknown[]
  readonly onLog: (entry: {
    level: string
    message: string
    addonId: string
    nodeId: string
    scope?: string
    tags?: LogTags
    meta?: Record<string, unknown>
  }) => void
  readonly onSetLogLevel?: (level: string) => void
  /**
   * D3 registration handshake. A node calls `$hub.registerNode` once it
   * has finished mounting EVERY service; the payload is its complete cap
   * manifest. Idempotent — replaces the node's prior manifest entirely.
   */
  readonly onRegisterNode?: (params: RegisterNodeParams) => void
  /** Explicit deregistration (graceful shutdown). `$node.disconnected` covers crashes. */
  readonly onUnregisterNode?: (nodeId: string) => void
  /**
   * The hub's mesh identity gate (D857). When present, `registerNode` asks it
   * whether the SENDER may register: a node registers only itself, and only
   * while it holds a certificate identity. Absent → no sender check (test
   * brokers); the hub always passes its gate.
   */
  readonly meshIdentity?: MeshIdentityGate
}

function senderOf(ctx: Context): string {
  return typeof ctx.nodeID === 'string' ? ctx.nodeID : ''
}

function createHubService(deps: HubServiceDeps): ServiceSchema {
  return {
    name: '$hub',
    // `$hub.event` was removed — remote events now reach the hub exclusively
    // through the `$event-bus` service via per-category `camstack.evt.<category>` broadcasts
    // (see `addon-context-factory.ts`).
    actions: {
      getAddonConfig: {
        handler(ctx: Context<{ addonId: string }>) {
          return deps.getAddonConfig(ctx.params.addonId)
        },
      },
      getSettings: {
        handler(ctx: Context<{ scope: string; key?: string }>) {
          return deps.getSettings(ctx.params.scope, ctx.params.key)
        },
      },
      getRecentEvents: {
        handler(ctx: Context<{ category?: string; limit?: number }>) {
          return deps.getRecentEvents(ctx.params.category, ctx.params.limit)
        },
      },
      log: {
        handler(
          ctx: Context<{
            level: string
            message: string
            addonId: string
            nodeId: string
            scope?: string
            tags?: LogTags
            meta?: Record<string, unknown>
          }>,
        ) {
          deps.onLog(ctx.params)
          return true
        },
      },
      setLogLevel: {
        handler(ctx: Context<{ level: string }>) {
          deps.onSetLogLevel?.(ctx.params.level)
          return true
        },
      },
      registerNode: {
        handler(ctx: Context<RegisterNodeParams>): RegisterNodeResult {
          // D857: the sender's certificate identity decides; throws when it may not register.
          // `clusterSecretHash` from a pre-D857 agent is ignored: there is no secret to check.
          deps.meshIdentity?.admitRegistration(senderOf(ctx), ctx.params.nodeId)
          // `ctx.params` is the COMPLETE manifest — addons AND the optional
          // device-scoped `nativeCaps`. The action forwards it verbatim; the
          // hub-side `onRegisterNode` decides how to apply each part.
          deps.onRegisterNode?.(ctx.params)
          return { ok: true }
        },
      },
      unregisterNode: {
        handler(ctx: Context<{ nodeId: string }>): RegisterNodeResult {
          deps.onUnregisterNode?.(ctx.params.nodeId)
          return { ok: true }
        },
      },
    },
  }
}

export { createHubService }
export type { HubServiceDeps }
