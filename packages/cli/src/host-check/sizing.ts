/**
 * Can this machine be a hub for the cameras the operator has in mind? Pure.
 *
 * Every figure comes from the planning page's measured numbers, carried by the
 * onboarding manifest (`sizing`); nothing here is a constant of ours. What was
 * never measured is said to be unmeasured: detection on a CPU with no
 * accelerator, or on a hardware class outside the latency table, has no
 * figure, so the verdict is "hub plus agents" with that limit stated and marked
 * PROVISIONAL. The node benchmark replaces it after install (D791, D1077).
 *
 * A fact that could not be read is `null` and its verdict is `unknown` — never
 * a zero that would read as "no memory" (D393).
 */
import { classifyCpuModel, type HardwareClassId } from '@camstack/types'
import type { Sizing } from '../onboarding/manifest-schema.js'
import type { HostCheckReport } from './host-check.js'

export const MAIN_STREAMS = ['4k', '1440p', '1080p'] as const
export type MainStream = (typeof MAIN_STREAMS)[number]
export const CODECS = ['h265', 'h264'] as const
export type Codec = (typeof CODECS)[number]
export const RECORDING_MODES = ['continuous', 'events', 'off'] as const
export type RecordingMode = (typeof RECORDING_MODES)[number]

export interface SizingRequest {
  readonly cameras: number
  readonly mainStream: MainStream
  readonly codec: Codec
  readonly recording: RecordingMode
  readonly retentionDays: number
  /** The main-stream bitrate the cameras really send, when the operator knows it. */
  readonly bitrateMbit?: number
}

/** What the machine has. `null`: could not be read. */
export interface HostFacts {
  /** The CPU string the OS reports; the host check's own read wins when it has one. */
  readonly cpuModel: string | null
  readonly ramGb: number | null
  readonly cores: number | null
  /** Free space on the volume recordings would go to. */
  readonly diskFreeGb: number | null
  readonly diskPath: string | null
}

export type Fit = 'ok' | 'tight' | 'short' | 'unknown'
export type FeasibilityVerdict = 'hub-only' | 'hub-plus-agents' | 'not-a-hub'

export type Range = readonly [number, number]

export interface FeasibilityReport {
  readonly request: SizingRequest
  readonly host: HostFacts
  readonly hardware: {
    readonly cpuModel: string | null
    readonly hardwareClass: HardwareClassId
    /** Whether the detector latency table has a column for this class. */
    readonly measured: boolean
    /** The accelerators the host check found that CamStack uses. */
    readonly accelerators: readonly string[]
  }
  readonly ram: { readonly needGb: Range; readonly haveGb: number | null; readonly fit: Fit }
  readonly cpu: {
    readonly typicalCores: Range
    readonly busyCores: Range
    readonly haveCores: number | null
    readonly fit: Fit
  }
  readonly disk: {
    /** `null`: no measured bitrate for this stream, and none was given. */
    readonly gbPerDay: Range | null
    readonly forRetentionGb: Range | null
    readonly haveGb: number | null
    readonly fit: Fit
  }
  readonly verdict: FeasibilityVerdict
  /** Always true before install: nothing was measured on this machine yet. */
  readonly provisional: boolean
  /** Why the verdict is what it is, most decisive first. */
  readonly reasons: readonly string[]
  /** What the figures do not cover. */
  readonly limits: readonly string[]
  readonly sizingPage: string
}

export const APPLE_ACCELERATOR = 'Apple Neural Engine and GPU'

const round1 = (n: number): number => Math.round(n * 10) / 10

function fitOf(have: number | null, need: number, comfortable: number): Fit {
  if (have === null) return 'unknown'
  if (have < need) return 'short'
  return have < comfortable ? 'tight' : 'ok'
}

function diskPerDay(request: SizingRequest, sizing: Sizing): Range | null {
  if (request.recording === 'off') return [0, 0]
  if (request.recording === 'events') {
    const [low, high] = sizing.eventsOnlyGbPerDay
    return [round1(low * request.cameras), round1(high * request.cameras)]
  }
  const bitrate =
    request.bitrateMbit ?? sizing.bitrateMbit[`${request.mainStream}-${request.codec}`]
  if (bitrate === undefined) return null
  const perDay = round1(bitrate * sizing.gbPerDayPerMbit * request.cameras)
  return [perDay, perDay]
}

export function assessFeasibility(
  request: SizingRequest,
  host: HostFacts,
  check: HostCheckReport,
  sizing: Sizing,
): FeasibilityReport {
  const cpuModel = check.cpu.model ?? host.cpuModel
  const found = check.accelerators.filter((a) => a.status === 'used')
  const nvidia = found.some((a) => a.kind === 'nvidia')
  const { hardwareClass } = classifyCpuModel(cpuModel ?? '', nvidia)
  // Apple silicon has no device node to find: the chip is the accelerator.
  const used: readonly string[] =
    hardwareClass === 'apple-m-base' || hardwareClass === 'apple-m-pro'
      ? [APPLE_ACCELERATOR]
      : found.map((a) => a.label)
  const measured = hardwareClass !== 'unknown'

  const [ramLow, ramHigh] = sizing.hubBaselineRamGb
  const needGb: Range = [
    round1(ramLow + request.cameras * sizing.perCameraRamGb),
    round1(ramHigh + request.cameras * sizing.perCameraRamGb),
  ]
  const [coreLow, coreHigh] = sizing.hubBaselineCores
  const typicalCores: Range = [
    round1(coreLow + request.cameras * sizing.perCameraCores),
    round1(coreHigh + request.cameras * sizing.perCameraCores),
  ]
  const busy = sizing.measuredHubCoresBusy / sizing.measuredHubCoresTypical
  const busyCores: Range = [round1(typicalCores[0] * busy), round1(typicalCores[1] * busy)]

  const ramFit: Fit =
    host.ramGb !== null && host.ramGb <= sizing.tightHubRamGb
      ? 'short'
      : fitOf(host.ramGb, needGb[1], sizing.minHubRamGb)
  const cpuFit = fitOf(host.cores, busyCores[1], busyCores[1] * 2)

  const gbPerDay = diskPerDay(request, sizing)
  const forRetentionGb: Range | null =
    gbPerDay === null
      ? null
      : [round1(gbPerDay[0] * request.retentionDays), round1(gbPerDay[1] * request.retentionDays)]
  const diskFit: Fit =
    forRetentionGb === null
      ? 'unknown'
      : fitOf(host.diskFreeGb, forRetentionGb[0], forRetentionGb[1] * 1.2)

  const reasons: string[] = []
  const limits: string[] = []
  let verdict: FeasibilityVerdict = 'hub-only'

  if (used.length === 0) {
    verdict = 'hub-plus-agents'
    reasons.push(
      'no accelerator CamStack uses was found here, and detection on a CPU alone was never measured: plan for an agent with a GPU, an NPU or a Coral, or expect to detect on few cameras',
    )
  } else if (!measured) {
    verdict = 'hub-plus-agents'
    reasons.push(
      `${cpuModel ?? 'this CPU'} is not in the measured tables, so how many cameras its ${used.join(', ')} carries is not known yet`,
    )
  } else {
    reasons.push(`${used.join(', ')} on a measured hardware class (${hardwareClass})`)
  }
  if (ramFit === 'short') {
    verdict = 'not-a-hub'
    reasons.unshift(
      host.ramGb !== null && host.ramGb <= sizing.tightHubRamGb
        ? `${String(host.ramGb)} GB of RAM is too tight: the hub alone uses ${String(ramLow)}–${String(ramHigh)} GB before any camera`
        : `${String(host.ramGb)} GB of RAM is below the ${String(needGb[1])} GB this load needs`,
    )
  } else if (ramFit === 'tight') {
    reasons.push(
      `${String(host.ramGb)} GB of RAM covers the load but is under the ${String(sizing.minHubRamGb)} GB the planning page suggests`,
    )
  }
  if (cpuFit === 'short') {
    if (verdict === 'hub-only') verdict = 'hub-plus-agents'
    reasons.push(
      `${String(host.cores)} core(s) is below the ${String(busyCores[1])} cores this load takes when busy`,
    )
  }
  if (ramFit === 'unknown') limits.push('the memory of this machine could not be read')
  if (cpuFit === 'unknown') limits.push('the core count of this machine could not be read')
  if (gbPerDay === null) {
    limits.push(
      `no bitrate was measured for ${request.mainStream} ${request.codec}: pass the bitrate your cameras send (bitrateMbit) to size the disk`,
    )
  } else if (diskFit === 'short') {
    reasons.push(
      `${String(host.diskFreeGb)} GB free holds less than the ${String(request.retentionDays)} day(s) asked for (${String(forRetentionGb?.[0])} GB)`,
    )
  } else if (diskFit === 'unknown') {
    limits.push('the free space of the recording volume could not be read')
  }
  limits.push(
    `the figures were measured on: ${sizing.measuredOn.join('; ')}`,
    'decoding and detection capacity are measured on the machine itself by the node benchmark after install; this verdict is provisional until then',
  )

  return {
    request,
    host,
    hardware: { cpuModel, hardwareClass, measured, accelerators: used },
    ram: { needGb, haveGb: host.ramGb, fit: ramFit },
    cpu: { typicalCores, busyCores, haveCores: host.cores, fit: cpuFit },
    disk: { gbPerDay, forRetentionGb, haveGb: host.diskFreeGb, fit: diskFit },
    verdict,
    provisional: true,
    reasons,
    limits,
    sizingPage: sizing.page,
  }
}

const range = (r: Range, unit: string): string =>
  r[0] === r[1] ? `${String(r[0])} ${unit}` : `${String(r[0])}–${String(r[1])} ${unit}`

const VERDICT_TEXT: Readonly<Record<FeasibilityVerdict, string>> = {
  'hub-only': 'this machine can be the hub on its own',
  'hub-plus-agents': 'use this machine as the hub and add an agent for detection',
  'not-a-hub': 'this machine is too small to be the hub',
}

/** The plain-text form `camstack host-check --cameras …` prints. */
export function renderFeasibility(report: FeasibilityReport): string {
  const have = (n: number | null, unit: string): string =>
    n === null ? 'unknown' : `${String(n)} ${unit}`
  const lines = [
    `Sizing for ${String(report.request.cameras)} camera(s), ${report.request.mainStream} ${report.request.codec}, recording ${report.request.recording}, ${String(report.request.retentionDays)} day(s)`,
    `  Memory   needs ${range(report.ram.needGb, 'GB')}, has ${have(report.ram.haveGb, 'GB')} — ${report.ram.fit}`,
    `  CPU      ${range(report.cpu.typicalCores, 'cores')} typical, ${range(report.cpu.busyCores, 'cores')} busy, has ${have(report.cpu.haveCores, 'cores')} — ${report.cpu.fit}`,
    report.disk.gbPerDay === null || report.disk.forRetentionGb === null
      ? '  Disk     not sized (no measured bitrate for this stream)'
      : `  Disk     ${range(report.disk.gbPerDay, 'GB')} a day, ${range(report.disk.forRetentionGb, 'GB')} for the retention, has ${have(report.disk.haveGb, 'GB')} free — ${report.disk.fit}`,
    '',
    `Verdict (provisional): ${VERDICT_TEXT[report.verdict]}`,
    ...report.reasons.map((r) => `  - ${r}`),
    'Not covered:',
    ...report.limits.map((l) => `  - ${l}`),
  ]
  return lines.join('\n')
}
