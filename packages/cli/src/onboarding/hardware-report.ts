/**
 * The "share your results" link for a machine outside the measured tables.
 *
 * It opens the `hardware_report` issue form of the public repository with the
 * host check and, when it exists, the node benchmark already filled in. The
 * operator reads it and presses Submit: nothing is posted from here.
 *
 * What goes in is exactly what the operator already saw from the host check —
 * the CPU string, the accelerators and their device nodes, the image tag — and
 * the benchmark numbers. No hostname, no address, no node id, no path outside
 * /dev and /sys.
 */
import type { HostCheckReport } from '../host-check/host-check.js'
import type { HardwareReport } from './manifest-schema.js'

export const REPORT_FIELD_LIMIT = 2_500

export interface HardwareReportFacts {
  readonly check: Pick<
    HostCheckReport,
    'platform' | 'environment' | 'cpu' | 'accelerators' | 'imageTag'
  >
  readonly ramGb: number | null
  readonly cores: number | null
  /** Benchmark lines, already free of node ids; absent before install. */
  readonly benchmark?: readonly string[]
}

export interface HardwareReportLink {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly page: string
}

const clip = (text: string): string =>
  text.length > REPORT_FIELD_LIMIT ? `${text.slice(0, REPORT_FIELD_LIMIT)}\n(truncated)` : text

export function hostSummary(facts: HardwareReportFacts): string {
  const { check } = facts
  const lines = [
    `CPU: ${check.cpu.model ?? 'unknown'}`,
    `Cores: ${facts.cores === null ? 'unknown' : String(facts.cores)}`,
    `Memory: ${facts.ramGb === null ? 'unknown' : `${String(facts.ramGb)} GB`}`,
    `Platform: ${check.platform}${check.environment.container ? ` (${check.environment.container})` : ''}${check.environment.proxmoxHost ? ' (Proxmox host)' : ''}${check.environment.unraidHost ? ' (Unraid host)' : ''}`,
    `Image: ${check.imageTag ?? 'none'}`,
    'Accelerators:',
    ...(check.accelerators.length === 0
      ? ['  none found']
      : check.accelerators.map((a) => `  - ${a.label}: ${a.status}`)),
  ]
  return lines.join('\n')
}

export function hardwareReportLink(
  spec: HardwareReport,
  facts: HardwareReportFacts,
): HardwareReportLink {
  const used = facts.check.accelerators.filter((a) => a.status === 'used').map((a) => a.kind)
  const title = `Hardware report: ${facts.check.cpu.model ?? 'unknown CPU'}${used.length > 0 ? ` (${[...new Set(used)].join(', ')})` : ' (CPU only)'}`
  const params = new URLSearchParams()
  if (spec.template !== undefined) params.set('template', spec.template)
  if (spec.labels.length > 0) params.set('labels', spec.labels.join(','))
  params.set('title', title)
  params.set('host-check', clip(hostSummary(facts)))
  params.set(
    'benchmark',
    facts.benchmark !== undefined && facts.benchmark.length > 0
      ? clip(facts.benchmark.join('\n'))
      : 'Not run yet.',
  )
  return { url: `${spec.issuesUrl}?${params.toString()}`, title, text: spec.text, page: spec.page }
}
