import type { ReolinkBaichuanApi } from '@apocaliss92/nodelink-js'
import type { IScopedLogger } from '@camstack/types'
import {
  type ReolinkHubConnection,
  readHubConnection,
  sameHubConnection,
} from './hub-connection.js'
import {
  connectReolinkHub,
  type HubApiPort,
  type HubChildHandle,
  ReolinkHubSession,
  type ReolinkHubSessions,
} from './reolink-hub-session.js'

/** One enabled integration of this addon, as the manager reads it. */
export interface HubIntegrationSettings {
  readonly id: string
  readonly name: string
  readonly settings: Readonly<Record<string, unknown>>
}

export interface ReolinkHubManagerDeps<TApi extends HubApiPort> {
  readonly logger: IScopedLogger
  /** The cameras attached to an integration's session (the registry's `childrenOf`). */
  readonly childrenOf: (integrationId: string) => readonly HubChildHandle[]
  /** Make a session reachable to its cameras (the registry's `set`), or withdraw it. */
  readonly publish: (integrationId: string, session: ReolinkHubSession<TApi> | null) => void
  readonly connect: (connection: ReolinkHubConnection) => Promise<TApi>
  /** The hub socket of `integrationId` came up (`true`) or went down. */
  readonly onConnectionChange: (integrationId: string, online: boolean) => void
}

/**
 * One {@link ReolinkHubSession} per NVR / Home Hub INTEGRATION (D985). `reconcile` is the one
 * entry point: it is handed the live list of this addon's enabled integrations at boot and on
 * every integration lifecycle event, and makes the sessions match it — upsert, re-dial on a
 * changed connection, close what vanished. The default integration (no host) stays a plain
 * container of standalone cameras and gets no session.
 */
export class ReolinkHubManager<TApi extends HubApiPort = ReolinkBaichuanApi> {
  readonly #sessions = new Map<string, ReolinkHubSession<TApi>>()
  readonly #deps: ReolinkHubManagerDeps<TApi>

  constructor(deps: ReolinkHubManagerDeps<TApi>) {
    this.#deps = deps
  }

  list(): readonly string[] {
    return [...this.#sessions.keys()]
  }

  get(integrationId: string): ReolinkHubSession<TApi> | null {
    return this.#sessions.get(integrationId) ?? null
  }

  async reconcile(integrations: readonly HubIntegrationSettings[]): Promise<void> {
    const { logger } = this.#deps
    const wanted = new Set<string>()
    for (const integration of integrations) {
      const read = readHubConnection(integration.settings)
      if (read.kind === 'no-host') continue // the default integration: standalone cameras only
      wanted.add(integration.id)
      if (read.kind !== 'ok') {
        // A host with no usable password. A locked secret is never read as empty and nothing is
        // minted in its place: the session that is already running (if any) is left alone.
        logger.warn('Reolink NVR integration has no usable password — no session started', {
          meta: { integrationId: integration.id, reason: read.kind },
        })
        continue
      }
      const existing = this.#sessions.get(integration.id)
      if (existing !== undefined) {
        if (!sameHubConnection(existing.connection, read.connection)) {
          await existing.reconfigure(read.connection)
        }
        continue
      }
      const session = new ReolinkHubSession<TApi>({
        integrationId: integration.id,
        name: integration.name,
        logger: logger.child(`hub-${integration.id}`),
        connection: read.connection,
        connect: this.#deps.connect,
        children: () => this.#deps.childrenOf(integration.id),
        onConnectionChange: (online) => this.#deps.onConnectionChange(integration.id, online),
      })
      this.#sessions.set(integration.id, session)
      this.#deps.publish(integration.id, session)
      session.start()
    }
    for (const [id, session] of [...this.#sessions]) {
      if (wanted.has(id)) continue
      this.#sessions.delete(id)
      this.#deps.publish(id, null)
      await session.close()
    }
  }

  async shutdown(): Promise<void> {
    for (const [id, session] of [...this.#sessions]) {
      this.#sessions.delete(id)
      this.#deps.publish(id, null)
      await session.close()
    }
  }
}

/** The manager of a real addon process: dials real hubs. */
export function createReolinkHubManager(
  deps: Pick<ReolinkHubManagerDeps<ReolinkBaichuanApi>, 'logger' | 'onConnectionChange'>,
  registry: ReolinkHubSessions,
): ReolinkHubManager {
  return new ReolinkHubManager({
    ...deps,
    childrenOf: (id) => registry.childrenOf(id),
    publish: (id, session) => registry.set(id, session),
    connect: connectReolinkHub,
  })
}
