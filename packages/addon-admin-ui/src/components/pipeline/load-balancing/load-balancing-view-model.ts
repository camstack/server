/**
 * Pure helpers of the Load balancing tab (D748, D755): what a slider commit and an
 * applied suggestion write, the advisory caps the accelerator rows show, and
 * how a stale device pin is named. The tab owns the queries; this owns the
 * shapes.
 */
import type {
  CapacityFallback,
  EffectiveShares,
  LoadBalancingSharesInput,
  ShareSource,
  StaleDevicePin,
  SuggestSharesResult,
} from '@camstack/types'
import type { WeightCommitEntry, WeightSliderNode } from '../placement-board/WeightSliderStack'
import i18n from '../../../i18n/index'

/**
 * One slider release → ONE `setLoadBalancingShares` write. A share of 0 is
 * stored as 1 (of 100): the store and both placement policies read a missing
 * or non-positive weight as "unset ⇒ 1", so a literal 0 would mean an equal
 * share, the opposite of what the slider shows.
 */
export function sharesWriteFromCommit(
  entries: readonly WeightCommitEntry[],
): LoadBalancingSharesInput {
  return {
    nodes: Object.fromEntries(entries.map((e) => [e.nodeId, Math.max(1, e.weight)])),
    devices: {},
  }
}

/** The suggestion's node and device shares as one write; skipped nodes keep theirs. */
export function sharesWriteFromSuggestion(result: SuggestSharesResult): LoadBalancingSharesInput {
  const nodes: Record<string, number> = {}
  const devices: Record<string, Record<string, number>> = {}
  for (const node of result.nodes) {
    if (node.share === null || node.share <= 0) continue
    nodes[node.nodeId] = node.share
    const deviceShares = Object.fromEntries(
      node.devices.filter((d) => d.share > 0).map((d) => [d.deviceKey, d.share]),
    )
    if (Object.keys(deviceShares).length > 0) devices[node.nodeId] = deviceShares
  }
  return { nodes, devices }
}

/** nodeId → deviceKey → advisory session cap, for the accelerator rows. */
export function suggestedCapsByNode(
  result: SuggestSharesResult,
): Readonly<Record<string, Readonly<Record<string, number | null>>>> {
  return Object.fromEntries(
    result.nodes.map((n) => [
      n.nodeId,
      Object.fromEntries(n.devices.map((d) => [d.deviceKey, d.suggestedMaxSessions])),
    ]),
  )
}

export function stalePinText(pin: StaleDevicePin): string {
  return pin.reason === 'disabled'
    ? i18n.t('helpers.loadBalancingViewModel.stalePinDisabled', { deviceKey: pin.deviceKey })
    : i18n.t('helpers.loadBalancingViewModel.stalePinMissing', { deviceKey: pin.deviceKey })
}

export interface ShareSliderView<T extends WeightSliderNode> {
  readonly nodes: readonly T[]
  /** Automatic shares are the system's: shown, not dragged (D750). */
  readonly readOnly: boolean
}

/**
 * What the node share sliders show. Automatic → the computed shares, read-only;
 * manual (or nothing read yet) → the stored sliders, editable.
 */
export function shareSliderView<T extends WeightSliderNode>(
  stored: readonly T[],
  effective: EffectiveShares | undefined,
): ShareSliderView<T> {
  if (effective === undefined || effective.source === 'manual' || effective.autoPending) {
    return {
      nodes: stored,
      readOnly: effective !== undefined && effective.source !== 'manual',
    }
  }
  const pct = new Map(effective.nodes.map((n) => [n.nodeId, n.configuredPct]))
  return {
    nodes: stored.map((node) => ({ ...node, weight: Math.round(pct.get(node.id) ?? node.weight) })),
    readOnly: true,
  }
}

/** One line naming the nodes that cannot take sessions and where their share goes; null = none. */
export function effectiveShareNote(
  effective: EffectiveShares,
  nameOf: (nodeId: string) => string,
): string | null {
  const out = effective.nodes.filter((n) => !n.eligible)
  if (out.length === 0) return null
  const into = effective.nodes
    .filter((n) => n.eligible)
    .map((n) => `${nameOf(n.nodeId)} ${Math.round(n.effectivePct)}%`)
    .join(', ')
  const names = out.map((n) => nameOf(n.nodeId)).join(', ')
  return i18n.t('helpers.loadBalancingViewModel.shareNote', { count: out.length, names, into })
}

/** The three share sources, in the order the selector shows them. */
export const SHARE_SOURCE_OPTIONS: readonly {
  readonly value: ShareSource
  readonly label: string
  readonly hint: string
}[] = [
  {
    value: 'hardware',
    get label() {
      return i18n.t('helpers.loadBalancingViewModel.hardwareLabel')
    },
    get hint() {
      return i18n.t('helpers.loadBalancingViewModel.hardwareHint')
    },
  },
  {
    value: 'benchmark',
    get label() {
      return i18n.t('helpers.loadBalancingViewModel.benchmarkLabel')
    },
    get hint() {
      return i18n.t('helpers.loadBalancingViewModel.benchmarkHint')
    },
  },
  {
    value: 'manual',
    get label() {
      return i18n.t('helpers.loadBalancingViewModel.manualLabel')
    },
    get hint() {
      return i18n.t('helpers.loadBalancingViewModel.manualHint')
    },
  },
]

/** Why one node under the `benchmark` source was sized from hardware; null = it was not. */
export function capacityFallbackText(fallback: CapacityFallback | null): string | null {
  if (fallback === 'no-benchmark-results')
    return i18n.t('helpers.loadBalancingViewModel.fallbackNone')
  if (fallback === 'partial-benchmark-results') {
    return i18n.t('helpers.loadBalancingViewModel.fallbackPartial')
  }
  return null
}

/** One line per node that fell back to hardware under the `benchmark` source; null = none did. */
export function benchmarkFallbackNote(
  effective: EffectiveShares,
  nameOf: (nodeId: string) => string,
): string | null {
  if (effective.source !== 'benchmark') return null
  const fell = effective.nodes.filter((n) => n.capacityFallback !== null)
  if (fell.length === 0) return null
  return fell
    .map((n) => `${nameOf(n.nodeId)}: ${capacityFallbackText(n.capacityFallback) ?? ''}`)
    .join(' · ')
}
