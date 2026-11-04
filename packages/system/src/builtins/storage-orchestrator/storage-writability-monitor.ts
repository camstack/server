/**
 * Is every DECLARED storage type writable? A type an installed addon declares
 * but that has no location in a writing mode refuses every write ("no writable
 * eventMedia storage location") and the operator learns of it from a 404
 * thumbnail days later. This turns that state into an alert through the
 * existing alert centre: a liveness finding under a stable id, which the centre
 * opens as one card and dismisses on the matching recovery.
 *
 * Only an ANSWERED state raises (D49, D315): a store that has not answered, a
 * declarer that did not load, a package that could not be read are all
 * "unknown", never "no writable location".
 */
import type { IScopedLogger, StorageLocation, StorageLocationDeclarer } from '@camstack/types'
import { EventCategory, mayWriteToLocation } from '@camstack/types'

export const WRITABILITY_FINDING_PREFIX = 'storage:no-writable-location:'
const STORAGE_PAGE = '/system/storage'

/** What stops working when the type has nowhere to write. */
const IMPACT_BY_TYPE: Readonly<Record<string, string>> = {
  eventMedia: 'no thumbnails or track photos are saved',
  recordings: 'no recordings are written',
  recordingsLow: 'no low-resolution recordings are written',
  artifacts: 'no analysis artifacts are saved',
  backups: 'no backups can be written',
}
const GENERIC_IMPACT = 'everything that writes to it is refused'

export interface WritabilityEmission {
  readonly category: EventCategory.SystemLivenessFailed | EventCategory.SystemLivenessRecovered
  readonly data: Readonly<Record<string, unknown>>
}

export interface WritabilityInput {
  /** False until the location store answered: then nothing can be said. */
  readonly authoritative: boolean
  readonly declarers: readonly StorageLocationDeclarer[]
  readonly locations: readonly StorageLocation[]
}

export interface WritabilityMonitorDeps {
  readonly emit: (event: WritabilityEmission) => void
  readonly logger: IScopedLogger
}

export class StorageWritabilityMonitor {
  private readonly failing = new Set<string>()
  private evaluated = false

  constructor(private readonly deps: WritabilityMonitorDeps) {}

  evaluate(input: WritabilityInput): void {
    if (!input.authoritative) return
    // A package that could not be read declares an unknown set of types.
    if (input.declarers.some((d) => d.addonId === null)) return
    const first = !this.evaluated
    this.evaluated = true
    const loaded = input.declarers.filter((d) => d.loaded)
    const types = new Map<string, { displayName: string; addons: string[] }>()
    for (const declarer of loaded) {
      for (const d of declarer.declarations) {
        const entry = types.get(d.id) ?? { displayName: d.displayName, addons: [] }
        if (declarer.addonId !== null && !entry.addons.includes(declarer.addonId)) {
          entry.addons.push(declarer.addonId)
        }
        types.set(d.id, entry)
      }
    }
    for (const [type, info] of types) {
      const findingId = `${WRITABILITY_FINDING_PREFIX}${type}`
      const writable = input.locations.some((l) => l.type === type && mayWriteToLocation(l))
      if (!writable) {
        this.failing.add(type)
        this.deps.logger.warn('storage-orchestrator: declared type has no writable location', {
          meta: { type, addons: info.addons },
        })
        this.deps.emit({
          category: EventCategory.SystemLivenessFailed,
          data: {
            findingId,
            severity: 'error',
            title: `No writable ${info.displayName.toLowerCase()} location`,
            message:
              `${info.displayName} (${type}) is needed by ${info.addons.join(', ')} but has no location ` +
              `that accepts writes: ${IMPACT_BY_TYPE[type] ?? GENERIC_IMPACT}. ` +
              'Add or re-enable a location on the Storage page.',
            href: STORAGE_PAGE,
            actionLabel: 'Open Storage',
          },
        })
      } else if (this.failing.delete(type) || first) {
        // First pass too: a recovery event the bus dropped must not leave a stale card.
        this.deps.emit({ category: EventCategory.SystemLivenessRecovered, data: { findingId } })
      }
    }
  }
}
