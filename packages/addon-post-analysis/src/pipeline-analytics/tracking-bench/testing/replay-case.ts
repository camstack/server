/**
 * The vitest helper for tracker tests (D681; "Interface for D683" §4). Plain
 * TypeScript — it throws an `Error` vitest reports, and imports nothing from
 * vitest, so a script can call it too.
 *
 *   expectCaseHonoured(await loadCaseFixture(dir), CASE_TRACKER)
 */
import type { CaseContent } from '../cases/case-fixture.js'
import { type CaseReport, checkCaseLabels, formatCaseReport } from '../cases/case-labels.js'
import { replayTape } from '../replay.js'
import type { TapeTrackerFactory } from '../trackers/tape-tracker.js'

export class CaseNotHonouredError extends Error {
  constructor(readonly report: CaseReport) {
    super(formatCaseReport(report).join('\n'))
    this.name = 'CaseNotHonouredError'
  }
}

export function replayCase(content: CaseContent, factory: TapeTrackerFactory): CaseReport {
  return checkCaseLabels(content, replayTape(content.tape, factory(), content.manifest.plane))
}

export function expectCaseHonoured(content: CaseContent, factory: TapeTrackerFactory): void {
  const report = replayCase(content, factory)
  if (report.violations.length > 0) throw new CaseNotHonouredError(report)
}
