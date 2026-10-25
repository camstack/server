/**
 * Mesh gate middleware (D802, D857): wraps every LOCAL action and event handler
 * so it sees each request another node sends with `ctx.nodeID` = the sender.
 *
 * Used on both sides of the mesh:
 *  - hub: {@link MeshIdentityGate} (the sender holds a verified certificate);
 *  - agent: {@link AgentMeshIdentityGate} (the sender is the certified hub).
 *
 * For a request from another node it:
 *  1. asks the gate's `admitCall` — refuse or allow;
 *  2. strips a forged identity from the params ({@link stripForgedIdentity}).
 *
 * Calls a node makes to itself (`ctx.nodeID` = own) pass untouched.
 */
import {
  Errors,
  type ActionHandler,
  type ActionSchema,
  type Context,
  type Middleware,
  type Service,
} from 'moleculer'
import {
  MESH_ACTION_FORBIDDEN_TYPE,
  MESH_NODE_UNAUTHENTICATED_TYPE,
  type MeshCallGate,
  type MeshCallVerdict,
} from './mesh-identity.js'
import { HUB_CAP_FWD_ACTION } from '../transport/hub-cap-forward.js'

/** Identity fields only the hub's own router / transport may set (D787, D-1). */
const IDENTITY_KEYS = ['caller', 'callerAddonId'] as const

function withoutIdentity(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  if (!IDENTITY_KEYS.some((k) => Object.prototype.hasOwnProperty.call(value, k))) return value
  const rest: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    if (!(IDENTITY_KEYS as readonly string[]).includes(key)) rest[key] = v
  }
  return rest
}

/**
 * The params of a request from another node, with every identity it claimed
 * removed:
 *  - a cap action's input loses `caller` (the user identity the hub's tRPC
 *    router injects for `caller: 'required'` methods — `keychainAdmin.reveal`
 *    reads it) and `callerAddonId` (the transport's addon stamp the keychain
 *    owner-checks);
 *  - `$hub-cap-fwd.forward` keeps its envelope `callerAddonId` — the forward
 *    service checks it against the sender's registered manifest — but the
 *    forwarded `args` lose both.
 */
export function stripForgedIdentity(action: string, params: unknown): unknown {
  if (action === HUB_CAP_FWD_ACTION) {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) return params
    const args: unknown = Reflect.get(params, 'args')
    const cleaned = withoutIdentity(args)
    return cleaned === args ? params : { ...params, args: cleaned }
  }
  return withoutIdentity(params)
}

/** Minimum gap between two "mesh event refused" lines for one sender. */
const DROPPED_EVENT_LOG_INTERVAL_MS = 60_000

/** Moleculer does not export its event-handler types; derive them from the hook. */
type LocalEventHook = NonNullable<Middleware['localEvent']>
type EventSchemaHandler = ReturnType<LocalEventHook>
type EventSchema = Parameters<LocalEventHook>[1]

interface GateLogger {
  warn(message: string, meta?: Record<string, unknown>): void
}

export interface MeshAccessMiddlewareOptions {
  readonly ownNodeId: string
  readonly gate: MeshCallGate
  readonly logger?: GateLogger
}

function senderOf(ctx: Context): string | null {
  const nodeID: unknown = ctx.nodeID
  return typeof nodeID === 'string' && nodeID.length > 0 ? nodeID : null
}

function noSenderError(action: string): Errors.MoleculerClientError {
  return new Errors.MoleculerClientError(
    `"${action}" refused: the call names no sender node`,
    403,
    MESH_NODE_UNAUTHENTICATED_TYPE,
  )
}

function paramNodeId(params: unknown): unknown {
  return params !== null && typeof params === 'object' ? Reflect.get(params, 'nodeId') : undefined
}

/**
 * Build the middleware. Pass it in `ServiceBroker({ middlewares: [...] })`
 * so it wraps every service, including the ones Moleculer creates itself.
 */
export function createMeshAccessMiddleware(options: MeshAccessMiddlewareOptions): Middleware {
  const { ownNodeId, gate, logger } = options
  // Refused events are high-frequency (a whole unauthenticated neighbour's
  // telemetry): report them per sender, at most once a minute, with the count.
  const dropped = new Map<string, { lastLogAt: number; count: number }>()
  const noteDroppedEvent = (sender: string, eventName: string): void => {
    const now = Date.now()
    const entry = dropped.get(sender) ?? { lastLogAt: 0, count: 0 }
    const count = entry.count + 1
    if (now - entry.lastLogAt >= DROPPED_EVENT_LOG_INTERVAL_MS) {
      logger?.warn('mesh event refused', { sender, event: eventName, droppedSinceLastLog: count })
      dropped.set(sender, { lastLogAt: now, count: 0 })
    } else {
      dropped.set(sender, { lastLogAt: entry.lastLogAt, count })
    }
  }
  return {
    name: 'CamstackMeshAccess',

    localAction(next: ActionHandler<Service>, action: ActionSchema): ActionHandler<Service> {
      const name = action.name ?? ''
      return function meshGatedAction(this: Service, ctx: Context): unknown {
        const sender = senderOf(ctx)
        // An in-process call carries the broker's own node id (Moleculer's Context); a call
        // with no usable sender arrived over transit with a stripped one - never local (D857).
        if (sender === null) return Promise.reject(noSenderError(name))
        if (sender === ownNodeId) return next.call(this, ctx)
        return runAdmitted.call(this, ctx, sender, gate.admitCall(sender, name))
      }

      function runAdmitted(
        this: Service,
        ctx: Context,
        sender: string,
        verdict: MeshCallVerdict,
      ): unknown {
        if (verdict.verdict === 'deny') {
          logger?.warn('mesh call refused', { sender, action: name, reason: verdict.errorType })
          return Promise.reject(
            new Errors.MoleculerClientError(verdict.message, 403, verdict.errorType),
          )
        }
        if (name === '$hub.unregisterNode' && paramNodeId(ctx.params) !== sender) {
          return Promise.reject(
            new Errors.MoleculerClientError(
              `node "${sender}" may unregister only itself`,
              403,
              MESH_ACTION_FORBIDDEN_TYPE,
            ),
          )
        }
        ctx.params = stripForgedIdentity(name, ctx.params)
        return next.call(this, ctx)
      }
    },

    localEvent(next: EventSchemaHandler, event: EventSchema): EventSchemaHandler {
      const name = event.name ?? ''
      return function meshGatedEvent(this: Service, ctx: Context): Promise<void> {
        const sender = senderOf(ctx)
        if (sender === null) {
          noteDroppedEvent('(no sender)', name)
          return Promise.resolve()
        }
        if (sender === ownNodeId) return Promise.resolve(next.call(this, ctx))
        if (gate.admitEvent(sender, name).verdict === 'deny') {
          noteDroppedEvent(sender, name)
          // Moleculer's error-handler middleware chains `.catch` on the result:
          // a refused event must still return a promise, never `undefined`.
          return Promise.resolve()
        }
        return Promise.resolve(next.call(this, ctx))
      }
    },
  }
}
