/**
 * Device command observation (D1022): the kernel side of the transition audit.
 *
 * A device command is observed at the seams that know WHO called, and only
 * there: the hub tRPC mount (a person, a token, an integration, a mesh node),
 * the UDS parent (the forked addon on the socket), and an in-process hub
 * addon's own `ctx.api` (the addon stamping it). Each builds one
 * {@link DeviceCommandObservation} and hands it to the process-wide registry,
 * which the hub mirror's correlator subscribes to.
 *
 * Telemetry, not a gate (D8, D11): a missing or broken observer never affects
 * the call, and the cost of a call that is not a command is one Set lookup
 * (D181).
 */
import type { TRPCLink } from '@trpc/client'
import type { AnyRouter } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import {
  isCommand,
  readCommandOrigin,
  type CommandActor,
  type CommandOriginClaim,
  type DeviceCommandObservation,
} from '@camstack/types'

export type CommandObserver = (obs: DeviceCommandObservation) => void

/** Fan-out of command observations to the subscribers of this process. */
export class CommandObserverRegistry {
  private readonly observers = new Set<CommandObserver>()

  subscribe(observer: CommandObserver): () => void {
    this.observers.add(observer)
    return () => {
      this.observers.delete(observer)
    }
  }

  /** How many observers are subscribed (a node that audits nothing has none). */
  observerCount(): number {
    return this.observers.size
  }

  observe(obs: DeviceCommandObservation): void {
    for (const observer of this.observers) {
      try {
        observer(obs)
      } catch {
        // Observation is best-effort and never affects the call it observes.
      }
    }
  }
}

let registry: CommandObserverRegistry | undefined

/** The process-wide registry. */
export function getCommandObserverRegistry(): CommandObserverRegistry {
  registry ??= new CommandObserverRegistry()
  return registry
}

/** Test seam: forget every subscriber. */
export function __resetCommandObserverRegistryForTests(): void {
  registry = undefined
}

/** What a seam knows about one call it may report. */
export interface CommandCallFacts {
  readonly capName: string
  readonly method: string
  /** The call's arguments as the caller sent them. */
  readonly args: unknown
  readonly actor: CommandActor
  readonly outcome?: Promise<void>
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build the observation for a call, or `null` when it is not a device
 * command: not a vocabulary action, or its arguments name no device.
 */
export function buildCommandObservation(
  call: CommandCallFacts,
  at: number,
): DeviceCommandObservation | null {
  if (!isCommand(call.capName, call.method)) return null
  if (!isRecord(call.args)) return null
  const deviceId = call.args['deviceId']
  if (typeof deviceId !== 'number' || !Number.isInteger(deviceId)) return null
  return {
    deviceId,
    capName: call.capName,
    method: call.method,
    args: call.args,
    actor: call.actor,
    at,
    ...(call.outcome !== undefined ? { outcome: call.outcome } : {}),
  }
}

/** Report a call to `sink` when it is a device command. Never throws. */
export function reportCommand(
  sink: CommandObserver | undefined,
  call: CommandCallFacts,
  now: () => number = Date.now,
): void {
  if (sink === undefined) return
  try {
    const obs = buildCommandObservation(call, now())
    if (obs !== null) sink(obs)
  } catch {
    // Best-effort, see the module doc.
  }
}

/**
 * The actor of a command an ADDON issued. The addon id is the transport stamp.
 * An origin claim adds the detail of why (an action run, a scheduler); it never
 * changes who the caller is.
 */
export function addonCommandActor(
  addonId: string,
  origin: CommandOriginClaim | undefined,
  nodeId?: string,
): CommandActor {
  if (origin === undefined) {
    return { kind: 'addon', addonId, ...(nodeId !== undefined ? { nodeId } : {}) }
  }
  if (origin.kind === 'action') {
    return {
      kind: 'action',
      addonId,
      actionId: origin.actionId,
      runId: origin.runId,
      ...(origin.automationId !== undefined ? { automationId: origin.automationId } : {}),
    }
  }
  return { kind: 'scheduler', addonId, schedulerId: origin.schedulerId }
}

interface Deferred {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (reason: unknown) => void
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined
  let reject: (reason: unknown) => void = () => undefined
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res()
    reject = rej
  })
  return { promise, resolve, reject }
}

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * A tRPC link for an in-process hub addon's `ctx.api`: it reports the addon's
 * device commands (the actor is the addon the client belongs to, with the origin
 * claim of the call) and passes every call through untouched.
 */
export function commandObserverLink<TRouter extends AnyRouter>(options: {
  readonly callerAddonId: string
  readonly sink: CommandObserver
}): TRPCLink<TRouter> {
  return () =>
    ({ op, next }) => {
      if (op.type !== 'mutation') return next(op)
      const dot = op.path.indexOf('.')
      if (dot < 0) return next(op)
      const capName = kebab(op.path.slice(0, dot))
      const method = op.path.slice(dot + 1)
      if (!isCommand(capName, method)) return next(op)
      const downstream = next(op)
      return observable((observer) => {
        const settled = deferred()
        const outcome = settled.promise
        // A rejected outcome is consumed by the correlator; this keeps an unobserved one quiet.
        outcome.catch(() => undefined)
        reportCommand(options.sink, {
          capName,
          method,
          args: op.input,
          actor: addonCommandActor(options.callerAddonId, readCommandOrigin(op.context)),
          outcome,
        })
        const sub = downstream.subscribe({
          next: (value) => observer.next(value),
          error: (err) => {
            settled.reject(err)
            observer.error(err)
          },
          complete: () => {
            settled.resolve()
            observer.complete()
          },
        })
        return () => sub.unsubscribe()
      })
    }
}

/** The credential kinds a principal's audit tag can name. */
type UserCredential = Extract<CommandActor, { kind: 'user' }>['credential']

function credentialOf(user: object): UserCredential {
  const tag: unknown = Reflect.get(user, 'auditTag')
  if (tag === 'session' || tag === 'token' || tag === 'integration') return tag
  return Reflect.get(user, 'isApiKey') === true ? 'token' : 'session'
}

/**
 * Who a hub tRPC call is from, read from the request context by narrowing (the
 * kernel cannot import the server's context type). A context with no HTTP
 * request behind it is a mesh peer: a node. Anything without a principal is
 * unknown (`null`) and the call is not reported with a made-up actor.
 */
export function commandActorFromContext(ctx: unknown): CommandActor | null {
  if (ctx === null || typeof ctx !== 'object') return null
  const user: unknown = Reflect.get(ctx, 'user')
  if (user === null || typeof user !== 'object') return null
  const id: unknown = Reflect.get(user, 'id')
  if (typeof id !== 'string' || id.length === 0) return null
  if (Reflect.get(ctx, 'req') === undefined) return { kind: 'node', nodeId: id }
  const username: unknown = Reflect.get(user, 'username')
  const credentialId: unknown = Reflect.get(user, 'credentialId')
  return {
    kind: 'user',
    userId: id,
    username: typeof username === 'string' ? username : id,
    credential: credentialOf(user),
    ...(typeof credentialId === 'string' ? { credentialId } : {}),
  }
}

/**
 * Report a command BEFORE it runs, with an outcome that settles when the call
 * does: a provider that writes its slice synchronously must find the command
 * already pending. `call` is invoked here; its result (or throw) is returned
 * untouched.
 */
export function runObservedCommand(
  sink: CommandObserver | undefined,
  facts: Omit<CommandCallFacts, 'outcome'>,
  call: () => unknown,
): unknown {
  if (sink === undefined || !isCommand(facts.capName, facts.method)) return call()
  const settled = deferred()
  // The correlator consumes the rejection; this keeps an unobserved one quiet.
  settled.promise.catch(() => undefined)
  reportCommand(sink, { ...facts, outcome: settled.promise })
  try {
    const result = call()
    Promise.resolve(result).then(() => settled.resolve(), settled.reject)
    return result
  } catch (err: unknown) {
    settled.reject(err)
    throw err
  }
}
