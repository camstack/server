import {
  effectiveRefreshIntervalMs,
  errMsg,
  type IScopedLogger,
  type StateRefreshReason,
} from '@dominevo/types'
import { vesyncRefreshPolicy, type VeSyncConnectionConfig } from './config.js'
import {
  type VeSyncClient,
  type VeSyncClientFactory,
  type VeSyncDeviceSnapshot,
  type VeSyncHumidifierSnapshot,
  type VeSyncPurifierSnapshot,
  type VeSyncSession,
  VeSyncSessionRejectedError,
} from './vesync-client-contract.js'
import {
  decideSessionRestore,
  newVeSyncTerminalId,
  rowOfSession,
  type VeSyncSessionStore,
  type VeSyncSignInReason,
  type VeSyncStoredSession,
  vesyncCredentialsFingerprint,
} from './vesync-session-store.js'
import { tsVeSyncClientFactory } from './vesync-tsvesync-client.js'

/** Status of a single VeSync account connection. */
export type VeSyncAccountStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** One device command: what to send, and who it is for (the log tag). */
export interface VeSyncCommand {
  /** The VeSync `cid` the command drives. */
  readonly nativeId: string
  /** The Dominevo device the command came from — every log line about it is tagged with it. */
  readonly deviceId: number
  /** What is sent, for the log (`setPower(on)`, `setFanSpeed(67)` …). */
  readonly name: string
  readonly run: (client: VeSyncClient) => Promise<void>
}

/** One device the core asks to re-read (D1062). */
export interface VeSyncRefreshTarget {
  /** The VeSync `cid` to read. */
  readonly nativeId: string
  /** The Dominevo device the read is for — the log tag. */
  readonly deviceId: number
}

/** The last command sent to a cid, until the read after it lands (for `totalMs`). */
interface PendingCommand {
  readonly name: string
  readonly started: number
}

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
  /** Fired after every device list and every single-device read, so the account fans the
   *  fresh snapshot out to its devices. */
  readonly onPolled: (accountId: string) => void
  /** Factory seam — defaults to the `tsvesync` adapter. */
  readonly makeClient?: VeSyncClientFactory
}

/**
 * Wraps exactly one {@link VeSyncClient} (= one VeSync account). VeSync exposes
 * no push channel via the wrapper we target, so the account is read on demand:
 * `start()` adopts the stored session (or signs in) and lists devices once; after
 * that the CORE decides when to read (D1062, the hub's state-refresh scheduler,
 * through each device's `device-state-refresh` cap) and {@link refresh} does it —
 * a scheduled tick re-lists the account, a command or its burst re-reads the
 * commanded device. The manager owns no timer. `onPolled` fires after every read.
 * Same fresh-client-on-reconnect discipline as the Velux / Rademacher managers.
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
  #devices: Map<string, VeSyncDeviceSnapshot> = new Map()
  /**
   * Freshness order of device reads. A poll takes a ticket when it starts; a single-device
   * refresh takes one when it lands and records it per device. A poll that lands later keeps,
   * for every device refreshed after it started, the fresher read (it read before the command).
   */
  #readSeq = 0
  #refreshedAt: Map<string, number> = new Map()
  /**
   * One device list at a time. The library rebuilds its device objects on every list, detail-less
   * until each is read, so a second list running beside the first could hand it objects it has not
   * read yet. A tick that lands while a poll runs is skipped (the running one answers it).
   */
  #pollInFlight: Promise<void> | null = null
  /** When the account list last landed (or failed): the age `revalidate` judges. */
  #lastListAt = 0
  #status: VeSyncAccountStatus = 'disconnected'
  /** Per cid, the command whose confirming read has not landed yet. */
  #pendingCommands: Map<string, PendingCommand> = new Map()
  #error: string | null = null
  /** Session writes, serialized so a start can wait for the one its sign-in queued. */
  #sessionWrites: Promise<void> = Promise.resolve()
  /**
   * The terminal id this integration presents to VeSync. Taken from the stored session when it
   * has one, else made once for this manager; every session saved carries it, so it survives a
   * restart. A fresh id per start is what made VeSync mail a "new login" on every restart.
   */
  #terminalId: string | null = null

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

  /** Every device snapshot (purifiers and humidifiers) known to this account. */
  getDevices(): readonly VeSyncDeviceSnapshot[] {
    return [...this.#devices.values()]
  }

  /** Resolve one device snapshot by its native id, or null. */
  getDevice(nativeId: string): VeSyncDeviceSnapshot | null {
    return this.#devices.get(nativeId) ?? null
  }

  /** All purifier snapshots known to this account. */
  getPurifiers(): readonly VeSyncPurifierSnapshot[] {
    return this.getDevices().filter((d): d is VeSyncPurifierSnapshot => d.kind === 'purifier')
  }

  /** Resolve a single purifier snapshot by its native id, or null. */
  getPurifier(nativeId: string): VeSyncPurifierSnapshot | null {
    const device = this.getDevice(nativeId)
    return device?.kind === 'purifier' ? device : null
  }

  /** Resolve a single humidifier snapshot by its native id, or null. */
  getHumidifier(nativeId: string): VeSyncHumidifierSnapshot | null {
    const device = this.getDevice(nativeId)
    return device?.kind === 'humidifier' ? device : null
  }

  /** The live client, or null when stopped. */
  get client(): VeSyncClient | null {
    return this.#client
  }

  /**
   * Adopt the stored session or sign in and list devices once. A failed
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
    const stored = await this.#loadSession()
    const terminalId = stored?.terminalId ?? this.#terminalId ?? newVeSyncTerminalId()
    this.#terminalId = terminalId
    const client = this.#makeClient({
      email: connection.email,
      password: connection.password,
      region: connection.region,
      ...(connection.countryCode !== undefined ? { countryCode: connection.countryCode } : {}),
      terminalId,
      onSession: (session) => this.#queueSessionSave(fingerprint, session),
    })
    this.#client = client

    const decision = decideSessionRestore(stored, fingerprint, Date.now())
    let signInReason: VeSyncSignInReason | null = null
    if (decision.kind === 'restore') {
      client.restoreSession(decision.session)
      try {
        this.#devices = indexDevices(await client.listDevices())
        // A session stored before the terminal id was kept: keep the one presented from now on.
        if (decision.session.terminalId === null) {
          this.#queueSessionSave(fingerprint, {
            ...decision.session,
            terminalId,
          })
        }
      } catch (err) {
        if (!(err instanceof VeSyncSessionRejectedError)) throw err
        signInReason = 'rejected'
        await this.#clearSession()
        await client.login()
        this.#devices = indexDevices(await client.listDevices())
      }
    } else {
      signInReason = decision.reason
      if (decision.reason !== 'none-stored') await this.#clearSession()
      await client.login()
      this.#devices = indexDevices(await client.listDevices())
    }
    this.#lastListAt = Date.now()
    await this.flushSessionWrites()
    this.#logger.info(
      signInReason === null
        ? 'VeSyncIntegrationManager: session restored'
        : `VeSyncIntegrationManager: signed in (${signInReason})`,
      {
        tags: { accountId: this.#id },
        meta: { session: signInReason ?? 'restored' },
      },
    )

    this.#status = 'connected'
    this.#onConnected(this.#id)
    this.#onPolled(this.#id)
    this.#logger.info('VeSyncIntegrationManager: started', {
      tags: { accountId: this.#id },
      meta: { deviceCount: this.#devices.size },
    })
  }

  /** Drop the client + snapshots. */
  async stop(): Promise<void> {
    const client = this.#client
    this.#client = null
    this.#devices = new Map()
    this.#refreshedAt = new Map()
    this.#pendingCommands = new Map()
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

  /**
   * Send one command. The re-read that shows its real state is the core's (D1062): the hub
   * awaits a `device-state-refresh` read before the command returns, then bursts while the
   * hold is unconfirmed — a refused command is re-read too (part of it may have landed). A
   * refused command is logged and thrown.
   */
  async runCommand(command: VeSyncCommand): Promise<void> {
    const client = this.#client
    const tags = { deviceId: command.deviceId }
    if (client === null) {
      throw new Error(`vesync: integration ${this.#id} is not connected — ${command.name} not sent`)
    }
    const started = Date.now()
    this.#pendingCommands = new Map(this.#pendingCommands).set(command.nativeId, {
      name: command.name,
      started,
    })
    try {
      await command.run(client)
    } catch (err) {
      this.#logger.warn(`vesync: command ${command.name} failed`, {
        tags,
        meta: {
          nativeId: command.nativeId,
          commandMs: Date.now() - started,
          error: errMsg(err),
        },
      })
      throw err
    }
    this.#logger.info(`vesync: command ${command.name} acknowledged`, {
      tags,
      meta: { nativeId: command.nativeId, commandMs: Date.now() - started },
    })
  }

  /**
   * Read what the core asked for (D1062): a scheduled tick re-lists the account; a command or
   * burst read re-reads each target's cid once. A failed read is logged, not thrown — the next
   * tick reads again.
   */
  async refresh(
    reason: StateRefreshReason,
    targets: readonly VeSyncRefreshTarget[],
  ): Promise<void> {
    if (reason === 'schedule') {
      await this.poll()
      return
    }
    const client = this.#client
    if (client === null) {
      for (const target of targets)
        this.#logger.debug(
          'VeSyncIntegrationManager: read skipped — the account is not connected',
          {
            tags: { deviceId: target.deviceId },
            meta: { integrationId: this.#id, reason },
          },
        )
      return
    }
    const byCid = new Map<string, VeSyncRefreshTarget>()
    for (const target of targets)
      if (!byCid.has(target.nativeId)) byCid.set(target.nativeId, target)
    for (const target of byCid.values()) await this.#readDevice(client, target, reason)
  }

  /** Re-read one cid and push its real state. A failed read is logged, not thrown. */
  async #readDevice(
    client: VeSyncClient,
    target: VeSyncRefreshTarget,
    reason: StateRefreshReason,
  ): Promise<void> {
    const tags = { deviceId: target.deviceId }
    const pending = this.#pendingCommands.get(target.nativeId)
    const label = pending === undefined ? reason : `${reason} after ${pending.name}`
    const asked = Date.now()
    try {
      const fresh = await client.refreshDevice(target.nativeId)
      if (this.#client !== client) return
      if (fresh === null) {
        this.#logger.warn(`vesync: refresh (${label}) found no such device`, {
          tags,
          meta: { nativeId: target.nativeId },
        })
        return
      }
      this.#readSeq += 1
      this.#refreshedAt = new Map(this.#refreshedAt).set(target.nativeId, this.#readSeq)
      this.#devices = new Map(this.#devices).set(target.nativeId, fresh)
      const pendingNow = new Map(this.#pendingCommands)
      pendingNow.delete(target.nativeId)
      this.#pendingCommands = pendingNow
      this.#onPolled(this.#id)
      const pushed = Date.now()
      this.#logger.info(`vesync: state refreshed (${label})`, {
        tags,
        meta: {
          nativeId: target.nativeId,
          reason,
          refreshMs: pushed - asked,
          power: fresh.power,
          ...(pending !== undefined ? { totalMs: pushed - pending.started } : {}),
        },
      })
    } catch (err) {
      this.#logger.warn(`vesync: refresh (${label}) failed — the next read updates it`, {
        tags,
        meta: {
          nativeId: target.nativeId,
          reason,
          refreshMs: Date.now() - asked,
          error: errMsg(err),
        },
      })
    }
  }

  /**
   * Re-list devices once, then fan the snapshot out (the core's scheduled read). Best-effort; one
   * at a time: a call that lands while a list runs is skipped (the running one answers it).
   */
  async poll(): Promise<void> {
    if (this.#client === null) {
      this.#logger.debug(
        'VeSyncIntegrationManager: account list skipped — the account is not connected',
        {
          meta: { integrationId: this.#id },
        },
      )
      return
    }
    if (this.#pollInFlight !== null) {
      this.#logger.debug(
        'VeSyncIntegrationManager: poll skipped — the previous one is still running',
        {
          tags: { accountId: this.#id },
        },
      )
      return
    }
    await this.#startList()
  }

  /**
   * Re-list the account and return once a list landed: joins the list already running (the
   * scheduled read included) instead of starting a second one. For a caller that must see
   * what the account holds NOW (the adoption page's refresh).
   */
  async relist(): Promise<void> {
    if (this.#pollInFlight !== null) {
      await this.#pollInFlight
      return
    }
    await this.#startList()
  }

  /**
   * Serve-and-revalidate (D224): when the last list is older than the account's refresh
   * interval and none runs, start ONE list in the background. Never joins nor waits on a
   * running one. Returns whether it started a list.
   */
  revalidate(now: number = Date.now()): boolean {
    if (this.#client === null || this.#pollInFlight !== null) return false
    const intervalMs = effectiveRefreshIntervalMs(
      vesyncRefreshPolicy(this.#id, this.#connection.pollIntervalMs),
    )
    if (now - this.#lastListAt < intervalMs) return false
    this.#logger.debug('VeSyncIntegrationManager: account list is stale, re-reading', {
      tags: { accountId: this.#id },
      meta: { ageMs: now - this.#lastListAt, intervalMs },
    })
    void this.#startList()
    return true
  }

  #startList(): Promise<void> {
    const client = this.#client
    if (client === null) return Promise.resolve()
    const run = this.#pollOnce(client).finally(() => {
      this.#lastListAt = Date.now()
      if (this.#pollInFlight === run) this.#pollInFlight = null
    })
    this.#pollInFlight = run
    return run
  }

  async #pollOnce(client: VeSyncClient): Promise<void> {
    this.#readSeq += 1
    const ticket = this.#readSeq
    try {
      const listed = indexDevices(await client.listDevices())
      if (this.#client !== client) return
      this.#devices = this.#keepFresherReads(listed, ticket)
    } catch (err) {
      this.#error = errMsg(err)
      this.#logger.debug('VeSyncIntegrationManager: device poll failed', {
        tags: { accountId: this.#id },
        meta: { error: this.#error },
      })
    }
    this.#onPolled(this.#id)
  }

  /** A poll's list, with every device refreshed after the poll started kept as refreshed. */
  #keepFresherReads(
    listed: Map<string, VeSyncDeviceSnapshot>,
    ticket: number,
  ): Map<string, VeSyncDeviceSnapshot> {
    const merged = new Map(listed)
    for (const [nativeId, seq] of this.#refreshedAt) {
      const current = this.#devices.get(nativeId)
      if (seq > ticket && current !== undefined && merged.has(nativeId)) {
        merged.set(nativeId, current)
      }
    }
    return merged
  }
}

/** Index a device snapshot list by native id. */
function indexDevices(devices: readonly VeSyncDeviceSnapshot[]): Map<string, VeSyncDeviceSnapshot> {
  const map = new Map<string, VeSyncDeviceSnapshot>()
  for (const device of devices) map.set(device.nativeId, device)
  return map
}
