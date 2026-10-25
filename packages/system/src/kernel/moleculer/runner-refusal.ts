/**
 * The runner -> parent half of the Init-refusal protocol (D877).
 *
 * A runner whose addon refused to start writes ONE line to stdout and exits
 * with {@link RUNNER_REFUSED_EXIT_CODE}:
 *
 *   REFUSED:<nodeId>:<json {addonId, code, reason, remedy}>
 *
 * The parent reads the line to learn the reason; the exit code alone is enough
 * to know it was a refusal (so a line lost to a closed pipe still classifies
 * correctly, with an unknown reason). Neither is a crash: the process service
 * does not hand the exit to the D6 breaker.
 */
import { AddonRefusedError } from '../addon-refused-error.js'

/** sysexits EX_CONFIG: "something was found in an unconfigured or misconfigured state". */
export const RUNNER_REFUSED_EXIT_CODE = 78

const REFUSED_PREFIX = 'REFUSED:'

export interface RunnerRefusalReport {
  readonly addonId: string
  readonly code: string
  readonly reason: string
  readonly remedy: string
}

/** The stdout line for a refusal. Always one line: JSON has no raw newline. */
export function formatRunnerRefusalLine(nodeId: string, report: RunnerRefusalReport): string {
  return `${REFUSED_PREFIX}${nodeId}:${JSON.stringify(report)}\n`
}

export function refusalReportOf(addonId: string, err: AddonRefusedError): RunnerRefusalReport {
  return { addonId, code: err.code, reason: err.message, remedy: err.remedy }
}

function isReport(value: unknown): value is RunnerRefusalReport {
  if (typeof value !== 'object' || value === null) return false
  const rec = value as Record<string, unknown>
  return (
    typeof rec['addonId'] === 'string' &&
    typeof rec['code'] === 'string' &&
    typeof rec['reason'] === 'string' &&
    typeof rec['remedy'] === 'string'
  )
}

/** The refusals announced in a chunk of runner stdout; lines that are not one are ignored. */
export function parseRunnerRefusals(nodeId: string, chunk: string): readonly RunnerRefusalReport[] {
  const prefix = `${REFUSED_PREFIX}${nodeId}:`
  const out: RunnerRefusalReport[] = []
  for (const line of chunk.split('\n')) {
    if (!line.startsWith(prefix)) continue
    try {
      const parsed: unknown = JSON.parse(line.slice(prefix.length))
      if (isReport(parsed)) out.push(parsed)
    } catch {
      // A torn line is not a report; the exit code still classifies the exit.
    }
  }
  return out
}
