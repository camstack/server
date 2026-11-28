/**
 * Adoption after a discovery refresh (D1090).
 *
 * The device manager already fronts every adoption call. After each refresh of
 * an integration instance it:
 *
 *  1. keeps one record per adopted candidate (who adopted it, whether the
 *     source still offers it);
 *  2. in `auto` mode, adopts the candidates that are not adopted and not
 *     tombstoned — through the SAME job engine an operator's pick starts;
 *  3. marks an adopted device `withdrawn` after 3 CONFIRMED discoveries
 *     without its candidate, and back to `offered` when the candidate returns.
 *
 * It NEVER releases or removes a device. A discovery that failed or came back
 * empty changes nothing (D49): an empty list is what a source that errored
 * quietly looks like, and counting it would withdraw every device. By design a
 * source that drops to ZERO candidates therefore withdraws nothing.
 *
 * A miss counts only when {@link ADOPTION_MISS_MIN_SPACING_MS} has passed since
 * the candidate's last counted miss, so three presses of Refresh withdraw
 * nothing. An unreadable tombstone list stops the whole pass (D49).
 *
 * A device released before records existed has none, so switching such an
 * instance to `auto` may adopt it again.
 *
 * Limitation: only candidates adopted WITHOUT a filter are counted for
 * `withdrawn`. A record made under a filter (a per-filter pick) is kept as it
 * is, because the listing here is the unfiltered one and would call it missing.
 *
 * The provider's declared default mode is learned from each refresh answer, so
 * `getMode` reports the same mode the pass applies once the instance refreshed
 * (until then, after a restart, it answers `manual`).
 *
 * One pass runs per instance at a time; a refresh that lands meanwhile is
 * coalesced into a single follow-up pass.
 */
import {
  ADOPTION_MISS_MIN_SPACING_MS,
  ADOPTION_WITHDRAW_AFTER_MISSES,
  errMsg,
  type AdoptedBy,
  type AdoptionRecord,
  type AdoptionStatus,
  type AdoptMode,
  type DiscoveredChildDevice,
  type IScopedLogger,
} from '@dominevo/types'
import type { AdoptedCandidate, StartAdoptionJobInput } from './adoption-job-engine.js'
import { modeKey, type AdoptionLedger } from './adoption-ledger.js'
import type { AdoptionJob } from '@dominevo/types'

/** The slice of the job engine the autopilot drives. */
export interface AutopilotJobs {
  start(input: StartAdoptionJobInput): Promise<{ jobId: string }>
  list(filter: { addonId?: string; integrationId?: string }): readonly AdoptionJob[]
}

/** The slice of a `device-adoption` provider the autopilot reads. */
export interface AutopilotProvider {
  listCandidates(input: {
    integrationId: string
    page: number
    pageSize: number
  }): Promise<{ readonly candidates: readonly DiscoveredChildDevice[] }>
}

export interface AdoptionAutopilotDeps {
  readonly ledger: AdoptionLedger
  readonly jobs: AutopilotJobs
  readonly resolveProvider: (addonId: string) => Promise<AutopilotProvider>
  /** deviceId → when it was deleted (D865). A throw means "unknown", never "none". */
  readonly tombstones: () => Promise<ReadonlyMap<number, number>>
  readonly logger: IScopedLogger
  readonly now?: () => number
}

export interface AfterRefreshInput {
  readonly addonId: string
  readonly integrationId: string
  readonly status: AdoptionStatus
}

const LIST_PAGE_SIZE = 20_000

interface PassSlot {
  pending: AfterRefreshInput | null
}

export class AdoptionAutopilot {
  /** The default mode each provider declared on its last refresh answer. */
  private readonly declaredDefaults = new Map<string, AdoptMode>()
  /** The instances with a pass running, and the refresh waiting behind it. */
  private readonly passes = new Map<string, PassSlot>()

  constructor(private readonly deps: AdoptionAutopilotDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Stored choice, else the provider's declared default, else `manual`. */
  async effectiveMode(
    addonId: string,
    integrationId: string,
    providerDefault?: AdoptMode,
  ): Promise<{ readonly adoptMode: AdoptMode; readonly stored: boolean }> {
    const stored = await this.deps.ledger.getMode(addonId, integrationId)
    if (stored !== null) return { adoptMode: stored, stored: true }
    const declared = providerDefault ?? this.declaredDefaults.get(modeKey(addonId, integrationId))
    return { adoptMode: declared ?? 'manual', stored: false }
  }

  async setMode(addonId: string, integrationId: string, adoptMode: AdoptMode): Promise<void> {
    await this.deps.ledger.setMode(addonId, integrationId, adoptMode)
    this.deps.logger.info('adoption: adopt mode stored', {
      tags: { addonId },
      meta: { integrationId, adoptMode },
    })
  }

  async listRecords(addonId: string, integrationId?: string): Promise<readonly AdoptionRecord[]> {
    return this.deps.ledger.listRecords(addonId, integrationId)
  }

  /** Record who adopted a candidate. An explicit adopt replaces a released/removed record. */
  async recordAdopted(adopted: AdoptedCandidate): Promise<void> {
    await this.deps.ledger.putRecord(
      freshRecord({
        addonId: adopted.addonId,
        integrationId: adopted.integrationId,
        childNativeId: adopted.childNativeId,
        deviceId: adopted.parentDeviceId,
        adoptedBy: adopted.adoptedBy,
        adoptedAt: this.now(),
        ...(adopted.filter !== undefined ? { filter: adopted.filter } : {}),
      }),
    )
  }

  /** The operator released a device: remember it, so `auto` never brings it back. */
  async markReleased(addonId: string, deviceId: number): Promise<void> {
    const records = await this.deps.ledger.listRecords(addonId)
    for (const r of records) {
      if (r.deviceId !== deviceId || r.released) continue
      await this.deps.ledger.putRecord({ ...r, released: true })
      this.deps.logger.info('adoption: device released, auto-adopt will not bring it back', {
        tags: { deviceId, addonId },
        meta: {
          integrationId: r.integrationId,
          childNativeId: r.childNativeId,
        },
      })
    }
  }

  /**
   * Run after a refresh that the provider answered. Never throws: an operator's
   * refresh must not fail because the bookkeeping did.
   */
  async afterRefresh(input: AfterRefreshInput): Promise<void> {
    const { addonId, integrationId, status } = input
    const key = modeKey(addonId, integrationId)
    if (status.defaultAdoptMode === undefined) this.declaredDefaults.delete(key)
    else this.declaredDefaults.set(key, status.defaultAdoptMode)
    // One pass per instance at a time: two overlapping passes would both read
    // the same record and both count a miss, or both start a job for a
    // candidate the other is adopting. A refresh that lands meanwhile is
    // coalesced into ONE more pass that runs when the current one ends.
    const running = this.passes.get(key)
    if (running !== undefined) {
      running.pending = input
      this.deps.logger.debug('adoption: a pass is running, this refresh is coalesced', {
        tags: { addonId },
        meta: { integrationId },
      })
      return
    }
    const slot: PassSlot = { pending: null }
    this.passes.set(key, slot)
    try {
      await this.runPass(input)
      for (let next = slot.pending; next !== null; next = slot.pending) {
        slot.pending = null
        await this.runPass(next)
      }
    } finally {
      this.passes.delete(key)
      this.deps.logger.debug('adoption: pass finished', {
        tags: { addonId },
        meta: { integrationId },
      })
    }
  }

  private async runPass(input: AfterRefreshInput): Promise<void> {
    const { addonId, integrationId, status } = input
    const tags = { addonId }
    try {
      if (status.lastError !== null) {
        this.deps.logger.info('adoption: refresh reported an error, nothing changes', {
          tags,
          meta: { integrationId, error: status.lastError },
        })
        return
      }
      const mode = await this.effectiveMode(addonId, integrationId, status.defaultAdoptMode)
      if (
        mode.adoptMode !== 'auto' &&
        (await this.deps.ledger.listRecords(addonId, integrationId)).length === 0
      ) {
        this.deps.logger.info('adoption: manual instance with no records, nothing to track', {
          tags,
          meta: { integrationId },
        })
        return
      }
      // `refresh` answers a status, not the candidates, so one list is needed here.
      const provider = await this.deps.resolveProvider(addonId)
      const listed = await provider.listCandidates({
        integrationId,
        page: 1,
        pageSize: LIST_PAGE_SIZE,
      })
      const candidates = listed.candidates
      if (candidates.length === 0) {
        this.deps.logger.info('adoption: discovery listed no candidates, nothing changes', {
          tags,
          meta: { integrationId },
        })
        return
      }
      const records = await this.deps.ledger.listRecords(addonId, integrationId)
      const synced = await this.syncRecords(addonId, integrationId, candidates, records)
      if (mode.adoptMode !== 'auto') {
        this.deps.logger.info('adoption: instance is manual, nothing adopted', {
          tags,
          meta: { integrationId },
        })
        return
      }
      await this.adoptNew(addonId, integrationId, candidates, synced)
    } catch (err) {
      this.deps.logger.warn('adoption: post-refresh pass failed, nothing changes', {
        tags,
        meta: { integrationId, error: errMsg(err) },
      })
    }
  }

  /** Backfill what was adopted without a record, then count presence and absence. */
  private async syncRecords(
    addonId: string,
    integrationId: string,
    candidates: readonly DiscoveredChildDevice[],
    existing: readonly AdoptionRecord[],
  ): Promise<readonly AdoptionRecord[]> {
    const byNative = new Map<string, AdoptionRecord>()
    for (const r of existing) if (r.filter === undefined) byNative.set(r.childNativeId, r)
    const present = new Set(candidates.map((c) => c.childNativeId))
    const out: AdoptionRecord[] = existing.filter((r) => r.filter !== undefined)
    // An unreadable list stops the pass (D49): a removed device must not count as live.
    const tombstones = await this.deps.tombstones()

    for (const c of candidates) {
      const known = byNative.get(c.childNativeId)
      if (c.alreadyAdopted && c.adoptedDeviceId !== null && known?.deviceId !== c.adoptedDeviceId) {
        // Adopted by a path that records nothing (an older adopt, `adoptionAdopt`
        // before this change): the source says it is adopted, so remember it.
        const filled = freshRecord({
          addonId,
          integrationId,
          childNativeId: c.childNativeId,
          deviceId: c.adoptedDeviceId,
          adoptedBy: 'operator',
          adoptedAt: this.now(),
        })
        await this.deps.ledger.putRecord(filled)
        byNative.set(c.childNativeId, filled)
        this.deps.logger.info('adoption: recorded an adopted candidate that had no record', {
          tags: { deviceId: c.adoptedDeviceId, addonId },
          meta: { integrationId, childNativeId: c.childNativeId },
        })
      }
    }

    for (const record of byNative.values()) {
      if (record.released || isTombstoned(record, tombstones)) {
        out.push(record)
        continue
      }
      out.push(await this.countPresence(record, present.has(record.childNativeId)))
    }
    return out
  }

  private async countPresence(record: AdoptionRecord, isPresent: boolean): Promise<AdoptionRecord> {
    const tags = { deviceId: record.deviceId, addonId: record.addonId }
    const meta = {
      integrationId: record.integrationId,
      childNativeId: record.childNativeId,
    }
    if (isPresent) {
      if (record.missedDiscoveries === 0 && record.adoptionState === 'offered') return record
      const back: AdoptionRecord = {
        ...record,
        missedDiscoveries: 0,
        lastMissAt: null,
        adoptionState: 'offered',
        withdrawnSince: null,
      }
      await this.deps.ledger.putRecord(back)
      if (record.adoptionState === 'withdrawn') {
        this.deps.logger.info('adoption: the source offers the device again', {
          tags,
          meta,
        })
      }
      return back
    }
    const now = this.now()
    if (record.lastMissAt !== null && now - record.lastMissAt < ADOPTION_MISS_MIN_SPACING_MS) {
      this.deps.logger.info('adoption: miss not counted, the last one is too recent', {
        tags,
        meta: { ...meta, missedDiscoveries: record.missedDiscoveries },
      })
      return record
    }
    const missed = record.missedDiscoveries + 1
    const withdraw = missed >= ADOPTION_WITHDRAW_AFTER_MISSES && record.adoptionState === 'offered'
    const next: AdoptionRecord = {
      ...record,
      missedDiscoveries: missed,
      lastMissAt: now,
      ...(withdraw ? { adoptionState: 'withdrawn' as const, withdrawnSince: this.now() } : {}),
    }
    await this.deps.ledger.putRecord(next)
    this.deps.logger.info(
      withdraw
        ? 'adoption: the source no longer lists the device, marked withdrawn (kept, never removed)'
        : 'adoption: the source did not list the device in this discovery',
      { tags, meta: { ...meta, missedDiscoveries: missed } },
    )
    return next
  }

  private async adoptNew(
    addonId: string,
    integrationId: string,
    candidates: readonly DiscoveredChildDevice[],
    records: readonly AdoptionRecord[],
  ): Promise<void> {
    const tags = { addonId }
    let tombstones: ReadonlyMap<number, number>
    try {
      tombstones = await this.deps.tombstones()
    } catch (err) {
      // A removed device must not come back because a read failed (D49).
      this.deps.logger.warn('adoption: tombstones unreadable, auto-adopt skipped', {
        tags,
        meta: { integrationId, error: errMsg(err) },
      })
      return
    }
    const byNative = new Map<string, AdoptionRecord>()
    for (const r of records) if (r.filter === undefined) byNative.set(r.childNativeId, r)

    const toAdopt: string[] = []
    let blocked = 0
    for (const c of candidates) {
      if (c.alreadyAdopted) continue
      const known = byNative.get(c.childNativeId)
      if (known !== undefined) {
        // A record means this candidate was adopted before: released or removed
        // stays gone until an operator adopts it again.
        blocked += 1
        this.deps.logger.info('adoption: candidate not auto-adopted, it was adopted before', {
          tags: { deviceId: known.deviceId, addonId },
          meta: {
            integrationId,
            childNativeId: c.childNativeId,
            reason:
              known.released || isTombstoned(known, tombstones)
                ? 'released-or-removed'
                : 'has-record',
          },
        })
        continue
      }
      toAdopt.push(c.childNativeId)
    }
    if (toAdopt.length === 0) {
      this.deps.logger.info('adoption: nothing new to auto-adopt', {
        tags,
        meta: { integrationId, blocked },
      })
      return
    }
    const running = this.deps.jobs
      .list({ addonId, integrationId })
      .some((j) => j.state === 'running')
    if (running) {
      this.deps.logger.info('adoption: an adoption job is already running, auto-adopt waits', {
        tags,
        meta: { integrationId, waiting: toAdopt.length },
      })
      return
    }
    const adoptedBy: AdoptedBy = 'auto'
    const { jobId } = await this.deps.jobs.start({
      addonId,
      integrationId,
      childNativeIds: toAdopt,
      adoptedBy,
    })
    this.deps.logger.info('adoption: auto-adopt started a job', {
      tags,
      meta: { integrationId, jobId, candidates: toAdopt.length, blocked },
    })
  }
}

function freshRecord(
  input: Pick<
    AdoptionRecord,
    'addonId' | 'integrationId' | 'childNativeId' | 'deviceId' | 'adoptedBy' | 'adoptedAt'
  > & { readonly filter?: string },
): AdoptionRecord {
  return {
    addonId: input.addonId,
    integrationId: input.integrationId,
    childNativeId: input.childNativeId,
    ...(input.filter !== undefined ? { filter: input.filter } : {}),
    deviceId: input.deviceId,
    adoptedBy: input.adoptedBy,
    adoptedAt: input.adoptedAt,
    adoptionState: 'offered',
    withdrawnSince: null,
    missedDiscoveries: 0,
    lastMissAt: null,
    released: false,
  }
}

function isTombstoned(record: AdoptionRecord, tombstones: ReadonlyMap<number, number>): boolean {
  const deletedAt = tombstones.get(record.deviceId)
  return deletedAt !== undefined && deletedAt >= record.adoptedAt
}
