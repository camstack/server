/**
 * The "Found on the network" list of the Add device modal: ONE row per device,
 * whichever of the three sources saw it.
 *
 * - `adoption`: what the integration's `device-adoption` provider lists;
 * - `scan`: what a network scan scoped to this integration found;
 * - `proposal`: what passive discovery proposed in the background.
 *
 * Two entries are the same device when they share ANY identity: the scan
 * `stableId`, the adoption `childNativeId` (the provider uses the same string
 * for both on purpose) or the host they were seen at. A row that merged several
 * sources keeps the scan hit — the only one `deviceManager.adoptDevice` takes.
 */

/** The part of a scan hit or proposal candidate the list reads. */
export interface ScanHit {
  readonly stableId: string
  readonly suggestedName: string
  readonly prefilledConfig: Readonly<Record<string, unknown>>
  readonly parentStableId?: string | undefined
  readonly selectable?: boolean | undefined
  readonly alreadyOnboarded?: boolean | undefined
  readonly onboardedDeviceId?: number | undefined
  readonly onboardedName?: string | undefined
  readonly setupIntegration?: boolean | undefined
  /** Parameters the provider cannot guess; the row asks for them before adding. */
  readonly needsParams?: readonly string[] | undefined
}

/** The part of a `device-adoption` candidate the list reads. */
export interface AdoptionEntry {
  readonly childNativeId: string
  readonly name: string
  readonly alreadyAdopted?: boolean | undefined
  readonly parentStableId?: string | undefined
}

export interface ProposalEntry<H extends ScanHit = ScanHit> {
  readonly id: string
  readonly candidate: H
}

export type CandidateSource = 'adoption' | 'scan' | 'proposal'

export interface NetworkCandidate<H extends ScanHit = ScanHit> {
  /** Stable row key: the first identity the row was seen under. */
  readonly key: string
  readonly name: string
  readonly address: string | null
  readonly sources: readonly CandidateSource[]
  /** The hit to hand to `adoptDevice`; null for a device only the adoption provider lists. */
  readonly hit: H | null
  /** `childNativeId` to hand to the adoption job when there is no hit. */
  readonly adoptionId: string | null
  readonly proposalId: string | null
  readonly alreadyAdded: boolean
  readonly addedName: string | null
  readonly needsParams: readonly string[]
  readonly parentKey: string | null
}

export interface MergeInput<H extends ScanHit = ScanHit> {
  readonly adoption: readonly AdoptionEntry[]
  readonly scan: readonly H[]
  readonly proposals: readonly ProposalEntry<H>[]
  /** `stableId` of every device that already exists on the hub. */
  readonly existingStableIds: ReadonlySet<string>
}

interface Draft<H extends ScanHit> {
  key: string
  ids: Set<string>
  name: string
  address: string | null
  sources: CandidateSource[]
  hit: H | null
  adoptionId: string | null
  proposalId: string | null
  alreadyAdded: boolean
  addedName: string | null
  needsParams: readonly string[]
  parentId: string | null
}

function hostOf(config: Readonly<Record<string, unknown>>): string | null {
  const host = config['host']
  return typeof host === 'string' && host.length > 0 ? host.toLowerCase() : null
}

function hostIdentity(host: string | null): readonly string[] {
  return host === null ? [] : [`host:${host}`]
}

export function mergeNetworkCandidates<H extends ScanHit>(
  input: MergeInput<H>,
): readonly NetworkCandidate<H>[] {
  const drafts: Draft<H>[] = []
  const byIdentity = new Map<string, Draft<H>>()

  const place = (ids: readonly string[], make: () => Draft<H>): Draft<H> => {
    const found = ids.map((id) => byIdentity.get(id)).find((d) => d !== undefined)
    const draft = found ?? make()
    if (found === undefined) drafts.push(draft)
    for (const id of ids) {
      draft.ids.add(id)
      byIdentity.set(id, draft)
    }
    return draft
  }

  const addSource = (draft: Draft<H>, source: CandidateSource): void => {
    if (!draft.sources.includes(source)) draft.sources.push(source)
  }

  for (const entry of input.adoption) {
    const draft = place([entry.childNativeId], () => ({
      key: entry.childNativeId,
      ids: new Set(),
      name: entry.name,
      address: null,
      sources: [],
      hit: null,
      adoptionId: entry.childNativeId,
      proposalId: null,
      alreadyAdded: false,
      addedName: null,
      needsParams: [],
      parentId: entry.parentStableId ?? null,
    }))
    addSource(draft, 'adoption')
    draft.adoptionId = entry.childNativeId
    if (entry.alreadyAdopted === true) draft.alreadyAdded = true
  }

  const absorb = (hit: H, source: CandidateSource, proposalId: string | null): void => {
    const host = hostOf(hit.prefilledConfig)
    const draft = place([hit.stableId, ...hostIdentity(host)], () => ({
      key: hit.stableId,
      ids: new Set(),
      name: hit.suggestedName,
      address: host,
      sources: [],
      hit: null,
      adoptionId: null,
      proposalId: null,
      alreadyAdded: false,
      addedName: null,
      needsParams: [],
      parentId: null,
    }))
    addSource(draft, source)
    // A scan hit is fresher than a proposal: it wins when both exist.
    if (draft.hit === null || source === 'scan') draft.hit = hit
    draft.name = hit.suggestedName
    draft.address = host ?? draft.address
    if (proposalId !== null) draft.proposalId = proposalId
    draft.parentId = hit.parentStableId ?? draft.parentId
    draft.needsParams = hit.needsParams ?? draft.needsParams
    if (
      hit.alreadyOnboarded === true ||
      hit.onboardedDeviceId !== undefined ||
      input.existingStableIds.has(hit.stableId)
    ) {
      draft.alreadyAdded = true
      draft.addedName = hit.onboardedName ?? draft.addedName
    }
  }

  for (const hit of input.scan) absorb(hit, 'scan', null)
  for (const proposal of input.proposals) absorb(proposal.candidate, 'proposal', proposal.id)

  for (const draft of drafts) {
    if ([...draft.ids].some((id) => input.existingStableIds.has(id))) draft.alreadyAdded = true
  }

  return drafts.map((d) => {
    const parent = d.parentId === null ? undefined : byIdentity.get(d.parentId)
    return {
      key: d.key,
      name: d.name,
      address: d.address,
      sources: d.sources,
      hit: d.hit,
      adoptionId: d.adoptionId,
      proposalId: d.proposalId,
      alreadyAdded: d.alreadyAdded,
      addedName: d.addedName,
      needsParams: d.needsParams,
      parentKey: parent !== undefined && parent !== d ? parent.key : null,
    }
  })
}
