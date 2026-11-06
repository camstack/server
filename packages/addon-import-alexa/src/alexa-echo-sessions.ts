/**
 * The seam between an Echo media-player device and the Amazon-account session
 * that talks to the Python worker. Device classes are built by the kernel with
 * only a context, so they reach the session through this in-process registry,
 * which the addon wires to the speak controller (same pattern as
 * {@link AlexaCommandSink}).
 */
import type { EchoPushSink, PushChannelState } from './speak/echo-push.js'
import type { BrokerEcho } from './speak/broker-echo.js'
import type { DeviceVolume } from './speak/worker-protocol.js'

/** What a device needs of one account's session. */
export type EchoSession = Pick<
  BrokerEcho,
  | 'state'
  | 'devices'
  | 'rateLimitedUntil'
  | 'playerState'
  | 'npCommand'
  | 'setVolume'
  | 'dndState'
  | 'deviceVolumes'
  | 'setDnd'
>

/** Devices of one account asking for Do Not Disturb in the same tick share ONE call. */
export const DND_SHARE_WINDOW_MS = 25_000

interface SharedDnd {
  readonly at: number
  readonly pending: Promise<ReadonlyMap<string, boolean>>
}

/** Devices of one account asking for the volume list in the same poll cycle share ONE call. */
export const VOLUME_SHARE_WINDOW_MS = 25_000

interface SharedVolumes {
  readonly at: number
  readonly pending: Promise<ReadonlyMap<string, DeviceVolume>>
}

export type EchoPushListener = () => void
export type EchoChannelListener = (state: PushChannelState) => void

export class EchoSessionRegistry implements EchoPushSink {
  readonly #channels = new Map<string, PushChannelState>()
  readonly #pushListeners = new Map<string, Set<EchoPushListener>>()
  readonly #channelListeners = new Map<string, Set<EchoChannelListener>>()

  #resolve: ((brokerId: string) => EchoSession | null) | null = null
  readonly #dnd = new Map<string, SharedDnd>()
  readonly #volumes = new Map<string, SharedVolumes>()

  setResolver(fn: (brokerId: string) => EchoSession | null): void {
    this.#resolve = fn
  }

  get(brokerId: string): EchoSession | null {
    return this.#resolve === null ? null : this.#resolve(brokerId)
  }

  /** Do Not Disturb of every device of the account. A failed read is not kept for the next device. */
  dnd(brokerId: string, now: number): Promise<ReadonlyMap<string, boolean>> {
    const shared = this.#dnd.get(brokerId)
    if (shared !== undefined && now - shared.at < DND_SHARE_WINDOW_MS) return shared.pending
    const session = this.get(brokerId)
    if (session === null) return Promise.reject(new Error('no Echo session for this account'))
    const pending = session.dndState()
    this.#dnd.set(brokerId, { at: now, pending })
    pending.catch(() => {
      if (this.#dnd.get(brokerId)?.pending === pending) this.#dnd.delete(brokerId)
    })
    return pending
  }

  /** Volume and mute of every device of the account. A failed read is not kept for the next device. */
  volumes(brokerId: string, now: number): Promise<ReadonlyMap<string, DeviceVolume>> {
    const shared = this.#volumes.get(brokerId)
    if (shared !== undefined && now - shared.at < VOLUME_SHARE_WINDOW_MS) return shared.pending
    const session = this.get(brokerId)
    if (session === null) return Promise.reject(new Error('no Echo session for this account'))
    const pending = session.deviceVolumes()
    this.#volumes.set(brokerId, { at: now, pending })
    pending.catch(() => {
      if (this.#volumes.get(brokerId)?.pending === pending) this.#volumes.delete(brokerId)
    })
    return pending
  }

  /** Forget the shared volume list: a list fetched before a set must not answer a poll after it. */
  invalidateVolumes(brokerId: string): void {
    this.#volumes.delete(brokerId)
  }

  /** Forget the shared Do Not Disturb list, for the same reason. */
  invalidateDnd(brokerId: string): void {
    this.#dnd.delete(brokerId)
  }

  /** Whether the account's push channel is open; `down` when nothing was ever reported. */
  pushChannel(brokerId: string): PushChannelState {
    return this.#channels.get(brokerId) ?? 'down'
  }

  channel(brokerId: string, state: PushChannelState): void {
    if (this.pushChannel(brokerId) === state) return
    this.#channels.set(brokerId, state)
    for (const listener of [...(this.#channelListeners.get(brokerId) ?? [])]) listener(state)
  }

  event(brokerId: string, serial: string): void {
    for (const listener of [...(this.#pushListeners.get(`${brokerId}\u0000${serial}`) ?? [])]) listener()
  }

  /** Called when Amazon pushes something about this Echo. Returns the unsubscribe. */
  onEcho(brokerId: string, serial: string, listener: EchoPushListener): () => void {
    return subscribe(this.#pushListeners, `${brokerId}\u0000${serial}`, listener)
  }

  /** Called when the account's channel goes up or down. Returns the unsubscribe. */
  onChannel(brokerId: string, listener: EchoChannelListener): () => void {
    return subscribe(this.#channelListeners, brokerId, listener)
  }

  clear(): void {
    this.#channels.clear()
    this.#pushListeners.clear()
    this.#channelListeners.clear()
    this.#resolve = null
    this.#dnd.clear()
    this.#volumes.clear()
  }
}

function subscribe<T>(map: Map<string, Set<T>>, key: string, listener: T): () => void {
  const set = map.get(key) ?? new Set<T>()
  set.add(listener)
  map.set(key, set)
  return () => {
    set.delete(listener)
    if (set.size === 0 && map.get(key) === set) map.delete(key)
  }
}

/** The single in-process registry shared across the addon. */
export const alexaEchoSessions = new EchoSessionRegistry()
