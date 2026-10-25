/**
 * Pure formatting for the Cluster → Auto tune tab (D745): the plan's
 * reasons and changes as operator text. No React, no data fetching.
 */
import type { AutoTunePlan, LatencySource } from '@camstack/types'
import i18n from '../../../i18n/index'

type NodePlan = AutoTunePlan['nodes'][number]
type Reason = NodePlan['reasons'][number]
type Warning = AutoTunePlan['warnings'][number]

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

function sessions(n: number): string {
  return i18n.t('helpers.autoTuneViewModel.sessions', { count: n })
}

const ACCELERATOR_LABEL: Readonly<Record<string, string>> = {
  'intel-npu': 'Intel NPU',
  'intel-igpu': 'Intel iGPU',
  'amd-igpu': 'AMD iGPU (WebGPU)',
  'amd-npu': 'AMD XDNA NPU',
  'x86-cpu': 'CPU',
  'arm-cpu': 'CPU',
  'apple-ane': 'Apple Neural Engine',
  coral: 'Coral Edge TPU',
}

const HARDWARE_LABEL: Readonly<Record<string, string>> = {
  'intel-core-ultra': 'Intel Core Ultra',
  'intel-n-series': 'Intel N-series',
  'apple-m-base': 'Apple M (base)',
  'apple-m-pro': 'Apple M Pro / Max / Ultra',
  'amd-phoenix': 'AMD Ryzen Phoenix / Hawk Point',
  unknown: 'Not measured',
}

export function acceleratorLabel(kind: string | null): string {
  return kind === null ? '—' : (ACCELERATOR_LABEL[kind] ?? kind)
}

export function hardwareLabel(kind: string | null): string {
  return kind === null ? '—' : (HARDWARE_LABEL[kind] ?? kind)
}

/** One reason as a sentence. */
export function reasonText(reason: Reason): string {
  switch (reason.kind) {
    case 'capacity':
      return i18n.t('helpers.autoTuneViewModel.capacity', {
        sessions: sessions(reason.sessions),
        min: reason.minSessions,
      })
    case 'tie-faster':
      return i18n.t('helpers.autoTuneViewModel.tieFaster', {
        over: reason.over,
        recall: pct(reason.recallDelta),
      })
    case 'stepped-down':
      return i18n.t('helpers.autoTuneViewModel.steppedDown', {
        from: reason.from,
        limitedBy: reason.limitedBy,
        to: reason.to,
      })
    case 'no-fit-lightest':
      return i18n.t('helpers.autoTuneViewModel.noFitLightest', {
        min: sessions(reason.minSessions),
        sessions: sessions(reason.sessions),
      })
    case 'derived-latency':
      return i18n.t('helpers.autoTuneViewModel.derivedLatency', { modelId: reason.modelId })
    case 'cpu-device':
      return i18n.t('helpers.autoTuneViewModel.cpuDevice')
    case 'device-disabled':
      return i18n.t('helpers.autoTuneViewModel.deviceDisabled')
    case 'device-unavailable':
      return i18n.t('helpers.autoTuneViewModel.deviceUnavailable')
    case 'node-offline':
      return i18n.t('helpers.autoTuneViewModel.nodeOffline')
    case 'no-hardware-facts':
      return i18n.t('helpers.autoTuneViewModel.noHardwareFacts')
    case 'no-measured-data':
      return i18n.t('helpers.autoTuneViewModel.noMeasuredData')
    case 'no-family-build':
      return i18n.t('helpers.autoTuneViewModel.noFamilyBuild', { format: reason.format })
    case 'kept-custom-pin':
      return i18n.t('helpers.autoTuneViewModel.keptCustomPin', {
        modelId: reason.modelId,
        deviceKey: reason.deviceKey,
      })
  }
}

/** One warning as a sentence. */
export function warningText(warning: Warning, nodeName: (nodeId: string) => string): string {
  switch (warning.kind) {
    case 'custom-pin-kept':
      return i18n.t('helpers.autoTuneViewModel.customPinNode', {
        node: nodeName(warning.nodeId),
        modelId: warning.modelId,
        deviceKey: warning.deviceKey,
      })
    case 'custom-registry-unreadable':
      return i18n.t('helpers.autoTuneViewModel.customRegistryUnreadable', { error: warning.error })
  }
}

/** Counts for the summary line and the confirmation. */
export interface PlanCounts {
  readonly modelChanges: number
  readonly thresholdClears: number
}

export function planCounts(plan: AutoTunePlan): PlanCounts {
  const modelChanges = plan.nodeChanges.reduce((n, c) => n + c.modelPins.length, 0)
  const thresholdClears = plan.nodeChanges.reduce((n, c) => n + c.thresholds.length, 0)
  return { modelChanges, thresholdClears }
}

/** `true` when applying would write nothing. */
export function planIsNoop(plan: AutoTunePlan): boolean {
  const c = planCounts(plan)
  return c.modelChanges + c.thresholdClears === 0
}

/** The detector model a device runs before → after, from the node changes. */
export function detectorChangeFor(
  plan: AutoTunePlan,
  nodeId: string,
  deviceKey: string,
): { readonly before: string | null; readonly after: string | null } | null {
  const change = plan.nodeChanges.find((c) => c.nodeId === nodeId && c.deviceKey === deviceKey)
  const pin = change?.modelPins.find((p) => p.stepId === 'object-detection')
  return pin === undefined ? null : { before: pin.before, after: pin.after }
}

/**
 * Where a device's speed came from (D791, D930): a node benchmark beats an
 * estimate, which beats the measured column. The plan says which one it used.
 */
export function latencySourceText(source: LatencySource | undefined, locale?: string): string {
  if (source?.kind === 'node-benchmark') {
    return i18n.t('helpers.autoTuneViewModel.latencyMeasured', {
      date: new Date(source.measuredAtMs).toLocaleDateString(locale, {
        day: 'numeric',
        month: 'short',
      }),
    })
  }
  if (source?.kind === 'estimated') {
    return i18n.t('helpers.autoTuneViewModel.latencyEstimated', {
      hardware: hardwareLabel(source.estimatedFrom),
    })
  }
  return i18n.t('helpers.autoTuneViewModel.latencyTable')
}
