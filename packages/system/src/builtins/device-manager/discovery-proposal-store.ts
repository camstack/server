/**
 * Persistent discovery proposals (D994) — `discovery-proposals` record kind.
 *
 * One row per (addon, candidate stableId). A device seen again moves
 * `lastSeenAt` and refreshes the candidate, never `dismissed` and never
 * `firstSeenAt`. What the operator already owns is filtered at READ time, so an
 * adoption done by any other path hides the proposal without a write.
 */
import type {
  DiscoveryProposal,
  DiscoveryProposalBody,
  RecordKindHandle,
  RecordsAccess,
} from '@camstack/types'
import { readAllRows } from '../../records/read-all-rows.js'
import { deviceManagerRecordKinds } from './record-kinds.js'

type CandidateOf = DiscoveryProposalBody['candidate']

/** What a read hides: devices and integrations the operator already has. */
export interface ProposalOwnership {
  readonly deviceStableIds: ReadonlySet<string>
  readonly integrationOriginIds: ReadonlySet<string>
}

export function proposalId(addonId: string, stableId: string): string {
  return `${addonId}::${stableId}`
}

export class DiscoveryProposalStore {
  constructor(
    private readonly kind: RecordKindHandle<DiscoveryProposalBody>,
    private readonly now: () => number = (): number => Date.now(),
  ) {}

  static of(records: Pick<RecordsAccess, 'kind'>, now?: () => number): DiscoveryProposalStore {
    return new DiscoveryProposalStore(
      records.kind(deviceManagerRecordKinds['discovery-proposals']),
      now,
    )
  }

  /** Record what a provider classified. Returns how many proposals are NEW. */
  async observe(addonId: string, candidates: readonly CandidateOf[]): Promise<number> {
    const at = this.now()
    let created = 0
    for (const candidate of candidates) {
      if (candidate.alreadyOnboarded === true) continue
      const id = proposalId(addonId, candidate.stableId)
      const existing = await this.kind.get(id)
      if (existing === null) created += 1
      await this.kind.put({
        id,
        at,
        data: {
          addonId,
          candidate,
          firstSeenAt: existing?.data.firstSeenAt ?? at,
          lastSeenAt: at,
          dismissed: existing?.data.dismissed ?? false,
        },
      })
    }
    return created
  }

  /** Not dismissed, not already a device, not an integration the operator owns. */
  async listVisible(owned: ProposalOwnership): Promise<readonly DiscoveryProposal[]> {
    const rows = await readAllRows(this.kind, { order: 'at' })
    const out: DiscoveryProposal[] = []
    for (const row of rows) {
      const { candidate, dismissed } = row.data
      if (dismissed) continue
      if (owned.deviceStableIds.has(candidate.stableId)) continue
      if (owned.integrationOriginIds.has(candidate.stableId)) continue
      out.push({ id: row.id, ...row.data })
    }
    return out
  }

  async dismiss(id: string): Promise<boolean> {
    const existing = await this.kind.get(id)
    if (existing === null) return false
    await this.kind.put({
      id,
      at: existing.data.lastSeenAt,
      data: { ...existing.data, dismissed: true },
    })
    return true
  }
}
