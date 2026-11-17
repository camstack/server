import { errMsg, type IScopedLogger } from '@camstack/types'
import type { VeSyncConnectionConfig } from './config.js'
import {
  type VeSyncClient,
  type VeSyncClientFactory,
  type VeSyncPurifierSnapshot,
  type VeSyncSession,
  VeSyncSessionRejectedError,
} from './vesync-client-contract.js'
import {
  decideSessionRestore,
  rowOfSession,
  type VeSyncSessionStore,
  type VeSyncSignInReason,
  type VeSyncStoredSession,
  vesyncCredentialsFingerprint,
} from './vesync-session-store.js'
import { tsVeSyncClientFactory } from './vesync-tsvesync-client.js'

/** Status of a single VeSync account connection. */
export type VeSyncAccountStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** Constructor options for {@link VeSyncIntegrationManager}. */
export interface VeSyncIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: VeSyncConnectionConfig
  readonly logger: IScopedLogger
  /** Where the account's session survives a restart (keychain-backed). */
  readonly sessions: VeSyncSessionStore
  readonly onConnected: (accountId: string) => void
  readonly onDisconnected: (accountId: string) => void
  /** Fired after every poll cycle so the account device fans the fresh snapshot
   *  out to its purifier children. */
  readonly onPolled: (accountId: string) => void
  /** Factory seam — defaults to the `tsvesync` adapter. */
  readonly makeClient?: VeSyncClientFactory
}

/**
 * Wraps exactly one {@link VeSyncClient} (= one VeSync account). VeSync exposes
 * no push channel via the wrapper we target, so the manager owns a poll loop: on
 * `start()` it adopts the stored session (or signs in), lists devices once, and then periodically re-lists them,
 * firing `onPolled` after every cycle. Mirrors the Velux / Rademacher integration
 * manager, with the same fresh-client-on-reconnect discipline.
 */
export class VeSyncIntegrationManager {
  readonly #id: string
  #connection: VeSyncConnectionConfig
  readonly #logger: IScopedLogger
  readonly #sessions: VeSyncSessionStore
  readonly #onConnected: (accountId: string) => void
  readonly #onDisconnected: (accountId: string) => void
  readonly #onPolled: (accountId: string) => void
  readonly #makeClient: VeSyncClientFactory

  #client: VeSyncClient | null = null
  #purifiers: Map<string, VeSyncPurifierSnapshot> = new Map()
  #status: VeSyncAccountStatus = 'disconnected'
  #pollTimer: ReturnType<typeof setInterval> | null = null
  #error: string | null = null
  /** Session writes, serialized so a start can wait for the one its sign-in queued. */
  #sessionWrites: Promise<void> = Promise.resolve()

  constructor(options: VeSyncIntegrationManagerOptions) {
    this.#id = options.id
    this.#connection = options.connection
    this.#logger = options.logger
    this.#sessions = options.sessions
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#onPolled = options.onPolled
    this.#makeClient = options.makeClient ?? tsVeSyncClientFactory
  }

  /** The integration id this manager serves. */
  get id(): string {
    return this.#id
  }

  /** Current connection status. */
  get status(): VeSyncAccountStatus {
    return this.#status
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): VeSyncConnectionConfig {
    return this.#connection
  }

  /** All purifier snapshots known to this account. */
  getPurifiers(): readonly VeSyncPurifierSnapshot[] {
    return [...this.#purifiers.values()]
  }

  /** Resolve a single purifier snapshot by its native id, or null. */
  getPurifier(nativeId: string): VeSyncPurifierSnapshot | null {
    return this.#purifiers.get(nativeId) ?? null
  }

  /** The live client, or null when stopped. Purifier children drive commands here. */
  get client(): VeSyncClient | null {
    return this.#client
  }

  /**
   * Adopt the stored session or sign in, list devices once, and start the poll loop. A failed
   * sign-in throws (the caller logs and keeps the device — a later `applyConnection` / restart
   * retries). A restored session the cloud refuses gets exactly one fresh sign-in.
   */
  async start(): Promise<void> {
    if (this.#client !== null) {
      this.#logger.warn('VeSyncIntegrationManager: start() called while running — stop first', {
        tags: { accountId: this.#id },
      })
      return
    }
    this.#status = 'connecting'
    this.#error = null

    const connection = this.#connection
    const fingerprint = vesyncCredentialsFingerprint(connection)
    const client = this.#makeClient({
      email: connection.email,
      password: connection.password,
      region: connection.region,
      ...(connection.countryCode !== undefined ? { countryCode: connection.countryCode } : {}),
      onSession: (session) => this.#queueSessionSave(fingerprint, session),
    })
    this.#client = client

    const decision = decideSessionRestore(await this.#loadSession(), fingerprint, Date.now())
    let signInReason: VeSyncSignInReason | null = null
    if (decision.kind === 'restore') {
      client.restoreSession(decision.session)
      try {
        this.#purifiers = indexPurifiers(await client.listDevices())
      } catch (err) {
        if (!(err instanceof VeSyncSessionRejectedError)) throw err
        signInReason = 'rejected'
        await this.#clearSession()
        await client.login()
        this.#purifiers = indexPurifiers(await client.listDevices())
      }
    } else {
      signInReason = decision.reason
      if (decision.reason !== 'none-stored') await this.#clearSession()
      await client.login()
      this.#purifiers = indexPurifiers(await client.listDevices())
    }
    await this.flushSessionWrites()
    this.#logger.info(
      signInReason === null
        ? 'VeSyncIntegrationManager: session restored'
        : `VeSyncIntegrationManager: signed in (${signInReason})`,
      { tags: { accountId: this.#id }, meta: { session: signInReason ?? 'restored' } },
    )

    this.#status = 'connected'
    this.#onConnected(this.#id)
    this.#onPolled(this.#id)
    this.#startPollLoop()
    this.#logger.info('VeSyncIntegrationManager: started', {
      tags: { accountId: this.#id },
      meta: { purifierCount: this.#purifiers.size },
    })
  }

  /** Stop the poll loop and drop the client + snapshots. */
  async stop(): Promise<void> {
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
    const client = this.#client
    this.#client = null
    this.#purifiers = new Map()
    this.#status = 'disconnected'
    if (client) {
      try {
        await client.logout()
      } catch (err) {
        this.#logger.warn('VeSyncIntegrationManager: logout failed', {
          tags: { accountId: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    }
    this.#onDisconnected(this.#id)
  }

  /** Wait until every session write queued so far has settled (a failed one is logged). */
  async flushSessionWrites(): Promise<void> {
    await this.#sessionWrites
  }

  /** Forget the stored session — the integration was deleted. */
  async forgetSession(): Promise<void> {
    await this.flushSessionWrites()
    await this.#clearSession()
  }

  async #loadSession(): Promise<VeSyncStoredSession | null> {
    try {
      return await this.#sessions.load(this.#id)
    } catch (err) {
      this.#logger.warn('VeSyncIntegrationManager: stored session unreadable — signing in', {
        tags: { accountId: this.#id },
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  async #clearSession(): Promise<void> {
    try {
      await this.#sessions.clear(this.#id)
    } catch (err) {
      this.#logger.warn('VeSyncIntegrationManager: clearing the stored session failed', {
        tags: { accountId: this.#id },
        meta: { error: errMsg(err) },
      })
    }
  }

  /** The client minted a session: persist it, bound to the credentials that minted it. */
  #queueSessionSave(fingerprint: string, session: VeSyncSession): void {
    const row = rowOfSession(this.#id, fingerprint, session)
    this.#sessionWrites = this.#sessionWrites.then(async () => {
      try {
        await this.#sessions.save(row)
      } catch (err) {
        this.#logger.warn('VeSyncIntegrationManager: saving the session failed', {
          tags: { accountId: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    })
  }

  /** Atomically replace the connection: stop, swap config, reconnect. */
  async applyConnection(connection: VeSyncConnectionConfig): Promise<void> {
    await this.stop()
    this.#connection = connection
    await this.start()
  }

  /** Re-list devices once, then fan the snapshot out. Best-effort. */
  async poll(): Promise<void> {
    const client = this.#client
    if (client === null) return
    try {
      this.#purifiers = indexPurifiers(await client.listDevices())
    } catch (err) {
      this.#error = errMsg(err)
      this.#logger.debug('VeSyncIntegrationManager: device poll failed', {
        tags: { accountId: this.#id },
        meta: { error: this.#error },
      })
    }
    this.#onPolled(this.#id)
  }

  #startPollLoop(): void {
    if (this.#pollTimer !== null) return
    this.#pollTimer = setInterval(() => {
      void this.poll().catch((err) => {
        this.#logger.warn('VeSyncIntegrationManager: poll cycle failed', {
          tags: { accountId: this.#id },
          meta: { error: errMsg(err) },
        })
      })
    }, this.#connection.pollIntervalMs)
    // Do not keep the event loop alive solely for polling.
    this.#pollTimer.unref?.()
  }
}

/** Index a purifier snapshot list by native id. */
function indexPurifiers(
  purifiers: readonly VeSyncPurifierSnapshot[],
): Map<string, VeSyncPurifierSnapshot> {
  const map = new Map<string, VeSyncPurifierSnapshot>()
  for (const purifier of purifiers) map.set(purifier.nativeId, purifier)
  return map
}
