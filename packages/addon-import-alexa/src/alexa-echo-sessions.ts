/**
 * The seam between an Echo media-player device and the Amazon-account session
 * that talks to the Python worker. Device classes are built by the kernel with
 * only a context, so they reach the session through this in-process registry,
 * which the addon wires to the speak controller (same pattern as
 * {@link AlexaCommandSink}).
 */
import type { BrokerEcho } from './speak/broker-echo.js'

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
  | 'setDnd'
>

/** Devices of one account asking for Do Not Disturb in the same tick share ONE call. */
export const DND_SHARE_WINDOW_MS = 25_000

interface SharedDnd {
  readonly at: number
  readonly pending: Promise<ReadonlyMap<string, boolean>>
}

export class EchoSessionRegistry {
  #resolve: ((brokerId: string) => EchoSession | null) | null = null
  readonly #dnd = new Map<string, SharedDnd>()

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

  clear(): void {
    this.#resolve = null
    this.#dnd.clear()
  }
}

/** The single in-process registry shared across the addon. */
export const alexaEchoSessions = new EchoSessionRegistry()
