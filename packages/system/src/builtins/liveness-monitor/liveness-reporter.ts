/**
 * Announce new liveness faults and their recoveries — never an unchanged fault.
 *
 * One ERROR line and one `SystemLivenessFailed` event per NEW finding id (the
 * alert centre turns it into one persistent alert), one INFO line and one
 * `SystemLivenessRecovered` when it is gone. Several families of checks run on
 * different cadences (the device checks wait out the boot grace, the storage
 * check does not), so a recovery is judged only within the family that was
 * just evaluated: a storage check that found nothing must not "recover" a
 * device finding it never looked at.
 */
import { createEvent, EventCategory, type IScopedLogger, type SystemEvent } from '@camstack/types'
import type { LivenessFinding } from './liveness-checks.js'

/** Event source stamped on every emission — the addon that observed it. */
const LIVENESS_SOURCE = { type: 'addon', id: 'liveness-monitor' } as const

export interface LivenessReporterDeps {
  readonly logger: IScopedLogger
  readonly emit: (event: SystemEvent) => void
}

export class LivenessReporter {
  /** Finding ids currently reported, so recovery can be detected and announced. */
  private readonly active = new Set<string>()

  constructor(private readonly deps: LivenessReporterDeps) {}

  /**
   * @param findings what the family found this evaluation
   * @param inFamily which ids the family owns — only those can recover here
   */
  report(findings: readonly LivenessFinding[], inFamily: (id: string) => boolean): void {
    const current = new Set(findings.map((f) => f.id))

    for (const finding of findings) {
      if (this.active.has(finding.id)) continue
      this.active.add(finding.id)
      this.deps.logger.error(`liveness: ${finding.title} — ${finding.message}`, {
        ...(finding.deviceId !== undefined ? { tags: { deviceId: finding.deviceId } } : {}),
        meta: { findingId: finding.id, severity: finding.severity },
      })
      this.deps.emit(
        createEvent(EventCategory.SystemLivenessFailed, LIVENESS_SOURCE, {
          findingId: finding.id,
          severity: finding.severity,
          title: finding.title,
          message: finding.message,
          ...(finding.deviceId !== undefined ? { deviceId: finding.deviceId } : {}),
          ...(finding.deviceName !== undefined ? { name: finding.deviceName } : {}),
        }),
      )
    }

    for (const id of [...this.active]) {
      if (current.has(id) || !inFamily(id)) continue
      this.active.delete(id)
      this.deps.logger.info(`liveness: recovered — ${id}`, { meta: { findingId: id } })
      this.deps.emit(
        createEvent(EventCategory.SystemLivenessRecovered, LIVENESS_SOURCE, { findingId: id }),
      )
    }
  }
}
