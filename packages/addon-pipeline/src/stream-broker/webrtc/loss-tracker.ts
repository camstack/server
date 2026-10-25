export interface LossSample {
  readonly packetsLost: number
  readonly highestSequence: number
}

export interface LossTrackerConfig {
  readonly analyzeWindowMs: number
  readonly minFailPercent: number
  readonly waitAfterResetMs: number
}

interface StampedSample extends LossSample {
  readonly time: number
}

/** Delta between two RTCP extended (32-bit) highest-sequence values, with
 *  32-bit wraparound handling. */
function seqDelta(from: number, to: number): number {
  const d = to - from
  return d < 0 ? d + 0x1_0000_0000 : d
}

/**
 * Windowed packet-loss tracker. Mirrors the adaptive tracker used by
 * reference NVR implementations: loss ratio = ΔpacketsLost / Δsequence
 * across the oldest and newest in-window samples; `isFailing` when that
 * exceeds `minFailPercent`. After a tier change (`markChanged`), samples
 * are ignored for `waitAfterResetMs` so the renegotiation's own transient
 * loss doesn't cascade a second downgrade.
 */
export class LossTracker {
  private samples: StampedSample[] = []
  private resetUntil = 0

  constructor(private readonly config: LossTrackerConfig) {}

  markChanged(now: number): void {
    this.samples = []
    this.resetUntil = now + this.config.waitAfterResetMs
  }

  track(sample: LossSample, now: number): void {
    if (now < this.resetUntil) return
    this.samples.push({ ...sample, time: now })
    const cutoff = now - this.config.analyzeWindowMs
    this.samples = this.samples.filter((s) => s.time > cutoff)
  }

  /** Current loss ratio over the window, or 0 when fewer than two samples. */
  lossRatio(): number {
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    if (!first || !last || first === last) return 0
    const seq = seqDelta(first.highestSequence, last.highestSequence)
    if (seq <= 0) return 0
    return (last.packetsLost - first.packetsLost) / seq
  }

  isFailing(now: number): boolean {
    if (now < this.resetUntil) return false
    return this.lossRatio() > this.config.minFailPercent
  }

  /**
   * True when the window holds enough recent receiver feedback for a
   * "healthy" verdict to MEAN anything.
   *
   * `lossRatio()` returns 0 with fewer than two in-window samples, so
   * `isFailing` is false for a session that has produced NO feedback at all —
   * a link so bad that RTCP never arrives reads identically to a perfect one.
   * A downgrade may act on that (0 loss ⇒ don't downgrade, which is safe); an
   * UPGRADE must not, because it spends bandwidth the session has never been
   * shown to have. Silence is not health.
   */
  hasEvidence(now: number): boolean {
    if (now < this.resetUntil) return false
    // Recency is checked here, not left to `track`'s pruning: pruning only
    // runs when a NEW sample arrives, so a session whose feedback STOPPED
    // keeps its last samples forever and would otherwise read as evidence.
    const cutoff = now - this.config.analyzeWindowMs
    let inWindow = 0
    for (const s of this.samples) {
      if (s.time > cutoff) inWindow += 1
    }
    return inWindow >= 2
  }
}
