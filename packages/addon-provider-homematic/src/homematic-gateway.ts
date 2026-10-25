import type { Homematic } from 'nodehomematic'

/**
 * Per-broker registry that device classes use to reach the live
 * `Homematic` facade for a given CCU connection.
 *
 * The kernel constructs device classes through the `deviceClasses` map
 * with only a `DeviceContext` — it cannot thread the facade in as a
 * constructor arg. The HA addon solves the same problem by routing every
 * device→hub call over the `broker` cap (tRPC). For this integration we
 * keep it simple and in-process: the registry owns one `Homematic` facade
 * per registered CCU and publishes it here; devices resolve it by
 * `brokerId`. Single-CCU installs (brokerId absent) fall back to the
 * primary (first-registered) broker for back-compat.
 */
export class HmFacadeResolver {
  readonly #facades: Map<string, Homematic> = new Map()
  #primary: string | null = null

  /**
   * Publish or remove the facade for a given broker id. Passing `null`
   * removes the entry and, if it was the primary, promotes the next
   * registered broker (if any) to primary.
   */
  set(brokerId: string, facade: Homematic | null): void {
    if (facade === null) {
      this.#facades.delete(brokerId)
      if (this.#primary === brokerId) {
        this.#primary = this.#facades.keys().next().value ?? null
      }
      return
    }
    this.#facades.set(brokerId, facade)
    if (this.#primary === null) {
      this.#primary = brokerId
    }
  }

  /**
   * Resolve the live facade for a broker id. A null/undefined id returns
   * the primary broker's facade — single-CCU back-compat for legacy
   * devices that were persisted without a `brokerId`.
   */
  get(brokerId?: string | null): Homematic | null {
    if (brokerId != null) {
      return this.#facades.get(brokerId) ?? null
    }
    if (this.#primary === null) return null
    return this.#facades.get(this.#primary) ?? null
  }

  /** Remove all registered facades (called on full shutdown). */
  clear(): void {
    this.#facades.clear()
    this.#primary = null
  }
}

/** The single in-process per-broker facade resolver shared between the
 *  registry and device instances. */
export const homematicFacades = new HmFacadeResolver()
