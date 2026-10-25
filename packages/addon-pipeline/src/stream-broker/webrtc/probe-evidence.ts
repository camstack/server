/**
 * The viewer's downlink probe for a device, as it reaches the broker (D635).
 *
 * Two routes, and both are kept because each covers what the other misses:
 *
 * - The offer's `hints.downlinkMbps` — the client's probe-climb offer and
 *   every server-driven re-offer (the cold start strips it). The client
 *   resends its CACHED probe there (cache TTL 30 s), so a hint is dated as
 *   old as that cache allows, not "now" (review m6).
 * - The client's telemetry (`networkQuality.reportClientStats` →
 *   `downlinkMbps` + `downlinkAgeMs`), sent whatever the probe read (review
 *   I4). Before this a probe below the client's `mid` threshold never reached
 *   the broker, which could not tell "measured slow" from "failed" and kept
 *   trying.
 *
 * The NEWER probe wins, whatever it reads. A good probe confirms a climb only
 * while fresh; a short one keeps holding until replaced (`climb-capacity.ts`).
 *
 * Clocks: a report's age is `broker now − lastUpdated`, and `lastUpdated` is
 * stamped by the HUB. On an agent the two clocks must agree to within the
 * seconds this tolerates; NTP does, a free-running clock does not (review m4).
 */

export interface ProbeEvidence {
  readonly kbps: number
  /** Broker-clock estimate of when the probe was measured, epoch ms. */
  readonly at: number
}

/** The telemetry fields a probe is read from. */
export interface ProbeReport {
  readonly downlinkMbps: number | undefined
  readonly downlinkAgeMs: number
  /** Age of the report itself at the broker, ms. */
  readonly reportAgeMs: number
}

/**
 * How long a probe CONFIRMS a climb. 120 000 ms: a live viewer re-reports its
 * probe every 2 s and re-probes on each re-offer; past two minutes a one-shot
 * path measurement is history and the try-climb is the safer judge.
 */
export const PROBE_EVIDENCE_TTL_MS = 120_000

/** The client's probe cache TTL (`DOWNLINK_TTL_MS`): the oldest a hinted probe can be. */
export const HINT_PROBE_MAX_AGE_MS = 30_000

function mbpsToKbps(mbps: number | undefined): number | null {
  return mbps !== undefined && Number.isFinite(mbps) && mbps > 0 ? mbps * 1000 : null
}

/** The probe an offer carried, dated conservatively; null when it carried none. */
export function probeFromHints(
  downlinkMbps: number | undefined,
  now: number,
): ProbeEvidence | null {
  const kbps = mbpsToKbps(downlinkMbps)
  return kbps === null ? null : { kbps, at: now - HINT_PROBE_MAX_AGE_MS }
}

/** The probe a telemetry report carried; null when it carried none. */
export function probeFromReport(report: ProbeReport, now: number): ProbeEvidence | null {
  const kbps = mbpsToKbps(report.downlinkMbps)
  if (kbps === null) return null
  return { kbps, at: now - Math.max(0, report.reportAgeMs) - Math.max(0, report.downlinkAgeMs) }
}

/** The more recent of two probes (either may be absent). */
export function newerProbe(a: ProbeEvidence | null, b: ProbeEvidence | null): ProbeEvidence | null {
  if (a === null) return b
  if (b === null) return a
  return b.at >= a.at ? b : a
}

export function isProbeFresh(probe: ProbeEvidence | null, now: number): boolean {
  return probe !== null && now - probe.at <= PROBE_EVIDENCE_TTL_MS
}

/**
 * How long the broker keeps a device's probe at all. 600 000 ms (10 min, the
 * try-backoff cap). A SHORT probe holds a climb until a newer probe replaces
 * it — and a viewer that cannot probe (no token yet, a share link, whose token
 * is not session-grade) never supplies one, so without an end one viewer's
 * 1.2 Mbps reading would hold every such viewer of the camera on `capacity`
 * until the broker restarted (review N1).
 */
export const PROBE_MEMORY_TTL_MS = 600_000

/** The newest probe per device, bounded in time and forgotten with the device's last session. */
export class DeviceProbeMemory {
  private readonly probes = new Map<number, ProbeEvidence>()

  constructor(private readonly ttlMs: number) {}

  /** Keep `probe` if it is newer than what is held; an absent one changes nothing. */
  record(deviceId: number, probe: ProbeEvidence | null): void {
    const kept = newerProbe(this.probes.get(deviceId) ?? null, probe)
    if (kept !== null) this.probes.set(deviceId, kept)
  }

  get(deviceId: number, now: number): ProbeEvidence | null {
    const probe = this.probes.get(deviceId)
    if (probe === undefined) return null
    if (now - probe.at > this.ttlMs) {
      this.probes.delete(deviceId)
      return null
    }
    return probe
  }

  /** The device's last adaptive session ended: nobody's probe speaks for the next viewer. */
  forget(deviceId: number): void {
    this.probes.delete(deviceId)
  }
}
