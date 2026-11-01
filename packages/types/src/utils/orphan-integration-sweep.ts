import { errMsg } from './err-msg.js'
import type { IScopedLogger } from '../interfaces/logging.js'

/** The minimum gap between the two answered reads that must both lack an integration. */
export const ORPHAN_SWEEP_MIN_INTERVAL_MS = 60_000

export interface OrphanIntegrationSweepOptions {
  readonly logger: IScopedLogger
  readonly minIntervalMs?: number
  readonly now?: () => number
}

export interface OrphanSweepInput {
  /** Integration ids that own at least one device in this provider. */
  readonly ownerIds: readonly string[]
  /** Every integration id the list read ANSWERED with, or null when the read threw. */
  readonly listedIds: readonly string[] | null
  /** Removes the devices of one integration through the provider's tombstone path; returns the count. */
  readonly removeDevices: (integrationId: string) => Promise<number>
}

export interface OrphanSweepResult {
  /** An integration became a suspect on this pass: a second answered read is owed. */
  readonly newSuspects: number
  readonly removed: readonly string[]
}

/**
 * Closes the gap D49 leaves: an integration deleted while its provider was down never emits an
 * event the provider sees. An integration id absent from an ANSWERED list is only a suspect; its
 * devices go (through the provider's own removeDevices) when a SECOND answered read, at least
 * `minIntervalMs` later, still lacks it. A read that threw changes nothing; reappearing clears.
 */
export class OrphanIntegrationSweep {
  readonly #logger: IScopedLogger
  readonly #minIntervalMs: number
  readonly #now: () => number
  readonly #suspects = new Map<string, number>()

  constructor(options: OrphanIntegrationSweepOptions) {
    this.#logger = options.logger
    this.#minIntervalMs = options.minIntervalMs ?? ORPHAN_SWEEP_MIN_INTERVAL_MS
    this.#now = options.now ?? Date.now
  }

  get minIntervalMs(): number {
    return this.#minIntervalMs
  }

  async sweep(input: OrphanSweepInput): Promise<OrphanSweepResult> {
    if (input.listedIds === null) return { newSuspects: 0, removed: [] }
    const listed = new Set(input.listedIds)
    const owners = new Set(input.ownerIds)
    const now = this.#now()
    let newSuspects = 0
    const removed: string[] = []

    for (const id of [...this.#suspects.keys()]) {
      if (listed.has(id) || !owners.has(id)) {
        this.#suspects.delete(id)
        this.#logger.info('Orphan integration suspect cleared', {
          meta: { integrationId: id, reason: listed.has(id) ? 'listed again' : 'owns no devices' },
        })
      }
    }

    for (const id of owners) {
      if (listed.has(id)) continue
      const since = this.#suspects.get(id)
      if (since === undefined) {
        this.#suspects.set(id, now)
        newSuspects += 1
        this.#logger.info('Integration owns devices but is absent from the list — suspect', {
          meta: { integrationId: id, minIntervalMs: this.#minIntervalMs },
        })
        continue
      }
      if (now - since < this.#minIntervalMs) continue
      try {
        const count = await input.removeDevices(id)
        this.#suspects.delete(id)
        removed.push(id)
        this.#logger.warn('Orphan integration devices removed — absent from two answered lists', {
          meta: { integrationId: id, removed: count, firstMissingAt: since },
        })
      } catch (err) {
        this.#logger.warn('Orphan integration device removal failed — kept as suspect', {
          meta: { integrationId: id, error: errMsg(err) },
        })
      }
    }
    return { newSuspects, removed }
  }
}

export interface OwnerIdsInput {
  readonly reg: {
    getAllForAddon(addonId: string): ReadonlyArray<{
      readonly id: number
      readonly parentDeviceId: number | null
    }>
  }
  readonly devices: { loadConfig(deviceId: number): Promise<Record<string, unknown>> }
  readonly addonId: string
  /** The integration id a top-level device's persisted config names, or null when it is not this provider's. */
  readonly ownerOf: (config: Record<string, unknown>) => string | null
}

/** The integration ids that own top-level devices of one provider (a config that cannot be read is skipped). */
export async function collectOwnerIntegrationIds(input: OwnerIdsInput): Promise<readonly string[]> {
  const ids = new Set<string>()
  for (const d of input.reg.getAllForAddon(input.addonId)) {
    if (d.parentDeviceId !== null) continue
    const cfg = await input.devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
    const owner = input.ownerOf(cfg)
    if (owner !== null) ids.add(owner)
  }
  return [...ids]
}
