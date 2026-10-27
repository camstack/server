import type { EspLink, EspState } from './esphome-link.js'

/** What a device hears about its board. */
export type EspHubEvent =
  | { readonly kind: 'state'; readonly state: EspState }
  | { readonly kind: 'connected'; readonly link: EspLink }
  | { readonly kind: 'disconnected' }

export type EspHubListener = (event: EspHubEvent) => void

/**
 * Per-board rendezvous between the registry (which owns the session) and the
 * devices (which the kernel builds with a `DeviceContext` only, so a live link
 * cannot be a constructor argument). The registry attaches and detaches the
 * link; a device subscribes by `brokerId` and is told when the board is
 * reachable, when it is not, and every state the board reports in between.
 *
 * In-process on purpose: this addon is hub-only (D952).
 */
export class EspLinkHub {
  readonly #links = new Map<string, EspLink>()
  readonly #listeners = new Map<string, Set<EspHubListener>>()
  readonly #stateUnsubs = new Map<string, () => void>()

  /** The live link of a board, or null when it is not reachable. */
  link(brokerId: string): EspLink | null {
    return this.#links.get(brokerId) ?? null
  }

  /** Publish a freshly opened link; replaces and detaches a previous one. */
  attach(brokerId: string, link: EspLink): void {
    this.detach(brokerId)
    this.#links.set(brokerId, link)
    this.#stateUnsubs.set(
      brokerId,
      link.onState((state) => this.emit(brokerId, { kind: 'state', state })),
    )
    this.emit(brokerId, { kind: 'connected', link })
  }

  /** Remove the link of a board and tell its devices. No-op when none is attached. */
  detach(brokerId: string): void {
    const unsub = this.#stateUnsubs.get(brokerId)
    if (unsub !== undefined) unsub()
    this.#stateUnsubs.delete(brokerId)
    if (this.#links.delete(brokerId)) this.emit(brokerId, { kind: 'disconnected' })
  }

  /** Listen to one board. Returns the unsubscribe. */
  subscribe(brokerId: string, listener: EspHubListener): () => void {
    const set = this.#listeners.get(brokerId) ?? new Set<EspHubListener>()
    set.add(listener)
    this.#listeners.set(brokerId, set)
    return () => {
      set.delete(listener)
    }
  }

  clear(): void {
    for (const brokerId of [...this.#links.keys()]) this.detach(brokerId)
    this.#listeners.clear()
  }

  private emit(brokerId: string, event: EspHubEvent): void {
    for (const listener of [...(this.#listeners.get(brokerId) ?? [])]) listener(event)
  }
}

/** The one in-process hub shared by the registry and the device instances. */
export const espLinkHub = new EspLinkHub()
