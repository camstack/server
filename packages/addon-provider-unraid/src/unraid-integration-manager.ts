import { errMsg, type IScopedLogger } from '@camstack/types'
import type { UnraidConnectionConfig } from './config.js'
import type {
  UnraidClientFactory,
  UnraidClientLike,
  UnraidServerIdentity,
  UnraidSnapshot,
} from './unraid-client-contract.js'

/** Status of a single Unraid instance connection. */
export type UnraidInstanceStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/**
 * Test-only default: production passes `makeLiveUnraidClient` from the addon, so a
 * manager built without a factory fails loudly instead of silently polling nothing.
 */
export const defaultUnraidClientFactory: UnraidClientFactory = () => {
  throw new Error('unraid: no client factory supplied to the integration manager')
}

/** Constructor options for {@link UnraidIntegrationManager}. */
export interface UnraidIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: UnraidConnectionConfig
  readonly logger: IScopedLogger
  readonly onConnected: (instanceId: string) => void
  readonly onDisconnected: (instanceId: string) => void
  /** Fired after every poll cycle so the addon fans the fresh snapshot out. */
  readonly onPolled: (instanceId: string) => void
  /** Factory seam — the addon passes the live `node-unraid` factory; specs inject their own. */
  readonly makeClient?: UnraidClientFactory
}

/**
 * Wraps exactly one {@link UnraidClientLike} (= one Unraid server). Owns a poll
 * loop: on `start()` it connects, fetches the first snapshot, and then
 * periodically re-fetches, firing `onPolled` after every cycle. Mirrors the
 * Velux / Ecowitt integration managers, with the same fresh-client-on-reconnect
 * discipline.
 */
export class UnraidIntegrationManager {
  readonly #id: string
  readonly #name: string
  #connection: UnraidConnectionConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (instanceId: string) => void
  readonly #onDisconnected: (instanceId: string) => void
  readonly #onPolled: (instanceId: string) => void
  readonly #makeClient: UnraidClientFactory

  #client: UnraidClientLike | null = null
  #snapshot: UnraidSnapshot | null = null
  #status: UnraidInstanceStatus = 'disconnected'
  #pollTimer: ReturnType<typeof setInterval> | null = null
  #error: string | null = null

  constructor(options: UnraidIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#onPolled = options.onPolled
    this.#makeClient = options.makeClient ?? defaultUnraidClientFactory
  }

  /** The integration id. */
  get id(): string {
    return this.#id
  }

  /** The integration's display name. */
  get name(): string {
    return this.#name
  }

  /** Current connection status. */
  get status(): UnraidInstanceStatus {
    return this.#status
  }

  /** The last error surfaced from the source, or null. */
  get error(): string | null {
    return this.#error
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): UnraidConnectionConfig {
    return this.#connection
  }

  /** The most-recent poll snapshot, or null before the first poll. */
  getSnapshot(): UnraidSnapshot | null {
    return this.#snapshot
  }

  /** The live client, or null when stopped. Entity children drive commands here. */
  get client(): UnraidClientLike | null {
    return this.#client
  }

  /**
   * Connect the client, fetch the first snapshot, and start the poll loop. A
   * failed connect throws (the caller logs and keeps the device — a later
   * `applyConnection` / restart retries).
   */
  async start(): Promise<void> {
    if (this.#client !== null) {
      this.#logger.warn('UnraidIntegrationManager: start() called while running — stop first', {
        tags: { instanceId: this.#id },
      })
      return
    }
    this.#status = 'connecting'
    this.#error = null

    const client = this.#makeClient({
      host: this.#connection.host,
      port: this.#connection.port,
      https: this.#connection.https,
      apiKey: this.#connection.apiKey,
      allowSelfSigned: this.#connection.allowSelfSigned,
    })
    this.#client = client

    await client.connect()
    this.#snapshot = await fetchSnapshot(client, this.#sectionFailed)

    this.#status = 'connected'
    this.#onConnected(this.#id)
    this.#onPolled(this.#id)
    this.#startPollLoop()
    this.#logger.info('UnraidIntegrationManager: started', {
      tags: { instanceId: this.#id },
      meta: {
        dockerCount: this.#snapshot.dockers?.length ?? null,
        vmCount: this.#snapshot.vms?.length ?? null,
        diskCount: this.#snapshot.disks.length,
      },
    })
  }

  /** Stop the poll loop and drop the client + snapshot. */
  async stop(): Promise<void> {
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
    const client = this.#client
    this.#client = null
    this.#snapshot = null
    this.#status = 'disconnected'
    if (client) {
      try {
        await client.disconnect()
      } catch (err) {
        this.#logger.warn('UnraidIntegrationManager: disconnect failed', {
          tags: { instanceId: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    }
    this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop, swap config, reconnect. */
  async applyConnection(connection: UnraidConnectionConfig): Promise<void> {
    await this.stop()
    this.#connection = connection
    await this.start()
  }

  /** Re-fetch the snapshot once, then fan it out. Best-effort. */
  async poll(): Promise<void> {
    const client = this.#client
    if (client === null) return
    try {
      this.#snapshot = await fetchSnapshot(client, this.#sectionFailed)
      this.#error = null
    } catch (err) {
      this.#error = errMsg(err)
      this.#logger.debug('UnraidIntegrationManager: snapshot poll failed', {
        tags: { instanceId: this.#id },
        meta: { error: this.#error },
      })
    }
    this.#onPolled(this.#id)
  }

  /** A list section that failed is unknown this poll; say so, it changes what is shown. */
  readonly #sectionFailed =
    (section: UnraidSnapshotSection) =>
    (error: string): void => {
      this.#logger.warn('UnraidIntegrationManager: section read failed — kept as unknown', {
        tags: { instanceId: this.#id },
        meta: { section, error },
      })
    }

  #startPollLoop(): void {
    if (this.#pollTimer !== null) return
    this.#pollTimer = setInterval(() => {
      void this.poll().catch((err) => {
        this.#logger.warn('UnraidIntegrationManager: poll cycle failed', {
          tags: { instanceId: this.#id },
          meta: { error: errMsg(err) },
        })
      })
    }, this.#connection.pollIntervalMs)
    // Do not keep the event loop alive solely for polling.
    this.#pollTimer.unref?.()
  }
}

/** A list section of the snapshot that may read as unknown on its own. */
type UnraidSnapshotSection = 'dockers' | 'vms' | 'ups'

/** Aggregate one snapshot from the client's domain namespaces. */
async function fetchSnapshot(
  client: UnraidClientLike,
  onSectionFailed: (section: UnraidSnapshotSection) => (error: string) => void,
): Promise<UnraidSnapshot> {
  const upsDomain = client.ups
  const [array, cpu, dockers, vms, ups, notifications, identity] = await Promise.all([
    client.array.get(),
    client.system.cpu(),
    readSection(() => client.docker.list(), onSectionFailed('dockers')),
    readSection(() => client.vms.list(), onSectionFailed('vms')),
    // A client without the UPS domain cannot say: unknown, not "no UPS".
    upsDomain === undefined
      ? Promise.resolve(null)
      : readSection(() => upsDomain.list(), onSectionFailed('ups')),
    client.notifications.active(),
    readIdentity(client),
  ])
  return {
    array,
    cpu,
    disks: array.disks,
    dockers,
    vms,
    ups,
    notifications,
    ...(identity.hostname !== null ? { hostname: identity.hostname } : {}),
    identity,
  }
}

/**
 * Read one optional list section of the snapshot. A failure is `null` (unknown), never an
 * empty list, and it never fails the whole poll: a host with the VM or Docker service off
 * still reports its array.
 */
async function readSection<T>(
  read: () => Promise<readonly T[]>,
  onFailed: (error: string) => void,
): Promise<readonly T[] | null> {
  try {
    return await read()
  } catch (err) {
    onFailed(errMsg(err))
    return null
  }
}

/**
 * The server's identity (D1059). A missing or failed read is `systemRead` / `serverRead`
 * false — its values unknown — and never fails the poll.
 */
export async function readIdentity(client: UnraidClientLike): Promise<UnraidServerIdentity> {
  const failures: string[] = []
  const attempt = async <T>(what: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read()
    } catch (err) {
      failures.push(`${what}: ${errMsg(err)}`)
      return null
    }
  }
  const systemInfo = client.system.info
  const system = systemInfo === undefined ? null : await attempt('system.info', () => systemInfo())
  const serverDomain = client.server
  const server =
    serverDomain === undefined ? null : await attempt('server.info', () => serverDomain.info())
  if (
    serverDomain !== undefined &&
    server === null &&
    failures.every((f) => !f.startsWith('server.info'))
  ) {
    failures.push('server.info: answered without a server')
  }
  return {
    systemRead: system !== null,
    machineUuid: system?.machineUuid ?? null,
    macs: system?.macs ?? null,
    hostname: system?.hostname ?? null,
    serverRead: server !== null,
    flashGuid: server?.flashGuid ?? null,
    lanIp: server?.lanIp ?? null,
    readFailures: failures,
  }
}
