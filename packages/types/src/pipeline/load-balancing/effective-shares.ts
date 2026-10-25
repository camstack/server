/**
 * The shares a session election actually reads, and the view the Load
 * balancing tab shows (D750). Pure.
 *
 * The SOURCE decides the configured weights: the automatic capacity shares
 * (`hardware` or `benchmark`, D755), or the operator's stored sliders. Eligibility decides the effective ones: a
 * node or device that cannot take a session now (offline, switched off, no
 * detect capability, unable to run the root) contributes nothing, and the
 * others split its share in proportion to their own. That redistribution is
 * exactly what `electByShare` does over its candidate set, so the view and
 * the election cannot disagree; the stored values are never rewritten for it.
 */
import {
  type CapacityFallback,
  type CapacitySource,
  type EffectiveDeviceShare,
  type EffectiveNodeShare,
  type EffectiveShares,
  isAutomaticShareSource,
  type SessionPlacementPolicy,
  type ShareSource,
  type ShareWeights,
} from './schemas.js'

export interface EffectiveSharesInput {
  readonly source: ShareSource
  /** Every node the view covers, eligible or not. */
  readonly nodeIds: readonly string[]
  readonly stored: ShareWeights
  /** The last automatic computation; null = none yet. */
  readonly auto: ShareWeights | null
  /** Per node, what the automatic answer was computed from. */
  readonly autoCapacity?: Readonly<
    Record<string, { readonly source: CapacitySource; readonly fallback: CapacityFallback | null }>
  >
  readonly eligibleNodes: readonly string[]
  /** nodeId → device keys that can take sessions; a node absent here lists none. */
  readonly eligibleDevices: Readonly<Record<string, readonly string[]>>
  /**
   * nodeId → device keys the node's probe answered WITHOUT (D919): stored
   * weights survive a device that left, but it takes no share — neither set
   * nor effective — and the election's weights never name it.
   */
  readonly absentDevices?: Readonly<Record<string, readonly string[]>>
  readonly policy?: SessionPlacementPolicy
  readonly computedAt?: number | null
  readonly trigger?: string | null
}

/** Weight a node or device has when its source names none (the balancer's own default). */
const DEFAULT_WEIGHT = 1

function positive(value: number | undefined): number {
  return value !== undefined && value > 0 ? value : DEFAULT_WEIGHT
}

function percentages(
  keys: readonly string[],
  weightOf: (key: string) => number,
  counts: (key: string) => boolean,
): Map<string, number> {
  const total = keys.reduce((sum, k) => sum + (counts(k) ? weightOf(k) : 0), 0)
  return new Map(
    keys.map((k) => [
      k,
      total > 0 && counts(k) ? Math.round((weightOf(k) / total) * 1000) / 10 : 0,
    ]),
  )
}

export function resolveEffectiveShares(input: EffectiveSharesInput): EffectiveShares {
  const useAuto = isAutomaticShareSource(input.source) && input.auto !== null
  const weights: ShareWeights = useAuto && input.auto !== null ? input.auto : input.stored
  const nodeWeights: Record<string, number> = {}
  for (const nodeId of input.nodeIds) nodeWeights[nodeId] = positive(weights.nodes[nodeId])
  const eligibleNodes = new Set(input.eligibleNodes)

  const configured = percentages(
    input.nodeIds,
    (k) => nodeWeights[k] ?? DEFAULT_WEIGHT,
    () => true,
  )
  const effective = percentages(
    input.nodeIds,
    (k) => nodeWeights[k] ?? DEFAULT_WEIGHT,
    (k) => eligibleNodes.has(k),
  )

  const deviceWeights: Record<string, Record<string, number>> = {}
  const nodes = input.nodeIds.map((nodeId): EffectiveNodeShare => {
    const eligibleKeys = new Set(input.eligibleDevices[nodeId] ?? [])
    const named = weights.devices[nodeId] ?? {}
    const absent = new Set(input.absentDevices?.[nodeId] ?? [])
    const keys = [...new Set([...Object.keys(named), ...eligibleKeys])]
      .filter((k) => !absent.has(k))
      .toSorted()
    const perDevice: Record<string, number> = {}
    for (const key of keys) perDevice[key] = positive(named[key])
    if (keys.length > 0) deviceWeights[nodeId] = perDevice
    const devConfigured = percentages(
      keys,
      (k) => perDevice[k] ?? DEFAULT_WEIGHT,
      () => true,
    )
    const devEffective = percentages(
      keys,
      (k) => perDevice[k] ?? DEFAULT_WEIGHT,
      (k) => eligibleNodes.has(nodeId) && eligibleKeys.has(k),
    )
    const devices = keys.map(
      (deviceKey): EffectiveDeviceShare => ({
        deviceKey,
        eligible: eligibleKeys.has(deviceKey),
        configuredPct: devConfigured.get(deviceKey) ?? 0,
        effectivePct: devEffective.get(deviceKey) ?? 0,
      }),
    )
    const capacity = useAuto ? input.autoCapacity?.[nodeId] : undefined
    return {
      nodeId,
      eligible: eligibleNodes.has(nodeId),
      configuredPct: configured.get(nodeId) ?? 0,
      effectivePct: effective.get(nodeId) ?? 0,
      capacitySource: capacity?.source ?? null,
      capacityFallback: capacity?.fallback ?? null,
      devices,
    }
  })

  return {
    source: input.source,
    policy: input.policy ?? 'share',
    autoPending: isAutomaticShareSource(input.source) && input.auto === null,
    computedAt: input.computedAt ?? null,
    trigger: input.trigger ?? null,
    nodes,
    nodeWeights,
    deviceWeights,
  }
}
