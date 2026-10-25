/**
 * AudioWatcher — the Notification Center's matcher for audio rules
 * (`NcConditions.audio`).
 *
 * PURE module: no I/O, no timers, no wall clock of its own. The clock enters
 * exclusively as the `now` argument to {@link AudioWatcher.observe}, so every
 * decision is deterministic and unit-testable. The hosting `NotificationCenter`
 * owns the feed and the rule-driven spec refresh; this module owns the in-RAM
 * window map and the confirmation decision.
 *
 * ── TWO EXCLUSIVE MODES (operator decision 2026-08-14, D157) ───────────────
 *
 * **LABEL mode** — the rule NAMES SOUNDS (`labels`). It confirms when
 * `confirmHits` labelled frames land inside `confirmWindowSec` (default 2
 * in 5 s). That is a COUNT of sparse frames, not a percentage of the
 * stream: YAMNet still labels only one to three frames per episode, so a
 * 60%-of-10s window can never fire, but two of those frames two seconds
 * apart can. A single-frame false positive (the live "Pianti" pattern)
 * never reaches 2. `confirmHits: 1` is the old first-frame behaviour.
 *
 * The per-label confidence floor still applies — it is the analyzer's own
 * `classificationMinScore`, applied per device before a label ever reaches
 * this module. The rule's `throttle` cooldown is the OTHER brake.
 *
 * **LEVEL mode** — the rule NAMES A LEVEL (`dbThreshold`). Unchanged, and the
 * window is the whole point: over `samplingSeconds`, at least `hitPercent`% of
 * the samples must be at or above the floor. Three properties:
 *
 *  1. **The window must be FULL.** A window open for two seconds of its ten is
 *     100% of nothing; confirming on it would make `samplingSeconds`
 *     decorative. Fullness is measured from when the key STARTED collecting
 *     ({@link WindowState.openedAt}), not from the oldest surviving sample —
 *     pruning keeps that one inside the window by construction, so the span of
 *     what is held can never tell a full window from a young one.
 *  2. **It SLIDES.** Samples older than the window fall out, so a burst that
 *     has aged out cannot carry a later window.
 *  3. **Confirming RE-ARMS.** The key is emptied on a confirmation, so one
 *     loud minute is a handful of confirmations at window granularity rather
 *     than one per sample.
 *
 * Keys are `(deviceId, spec)`. Rules that agree on every spec field SHARE a
 * window — the same merge `OccupancyWatcher` does on a colliding key — and a
 * rule edited to a different threshold gets a different key, whose predecessor
 * `setWatchedSpecs` drops. Nothing here is persisted: an audio window is at
 * most `samplingSeconds` of recent sound, and re-opening it after a restart
 * costs exactly that.
 */

import {
  audioModeOf,
  NC_AUDIO_CONFIRM_HITS_DEFAULT,
  NC_AUDIO_CONFIRM_WINDOW_SEC_DEFAULT,
  type AudioClassifyOutcome,
  type NcAudioCondition,
} from '@camstack/types'

/**
 * Minimum samples a LEVEL window must hold to be judged at all.
 *
 * A window that is full by the clock but holds ONE sample is a camera whose
 * audio plane just came back, and 100% of one sample is not evidence of a
 * sustained sound. Two is the smallest number for which "percentage of the
 * samples" means anything; the analyzer produces far more than that in any
 * real window (~1 s inference frames at minimum).
 */
const MIN_WINDOW_SAMPLES = 2

/** One audio sample — the analyzer's inference window, as the pipeline emits it. */
export interface AudioSample {
  readonly timestampMs: number
  /** dBFS level (negative-going). Absent when the frame carried no level. */
  readonly dbfs?: number
  /**
   * Macro classes the classifier put on this sample (may be empty).
   *
   * Already confidence-gated by the analyzer's per-device
   * `classificationMinScore` — a label reaching this module is one the
   * classifier was confident enough about.
   */
  readonly labels: readonly string[]
  /**
   * Whether the analyzer's model RAN on this sample (D660). A `not-classified`
   * sample carries no labels because nobody listened, not because nothing was
   * heard. Neither mode needs a branch for it today: LABEL mode keeps only HIT
   * timestamps (an empty sample changes nothing), and the level is measured
   * on every window, so LEVEL mode counts it. A future label rule that counts
   * MISSES must read this first. Absent on a frame from an analyzer older
   * than D660 — unknown.
   */
  readonly classifyOutcome?: AudioClassifyOutcome
}

/**
 * The rule's watched question, normalized and device-agnostic (the same spec
 * applies to every device the rule observes). A discriminated union because
 * the two modes share NO tuning: a label rule has no window, and a level rule
 * has no labels.
 */
export type AudioWindowSpec =
  | {
      readonly mode: 'label'
      /** Normalized (see {@link normalizeAudioLabel}), sorted, deduplicated. */
      readonly labels: readonly string[]
      /** Labelled frames that must land inside {@link confirmWindowSec}. */
      readonly confirmHits: number
      /** Window those frames must share, in seconds. */
      readonly confirmWindowSec: number
    }
  | {
      readonly mode: 'level'
      readonly dbThreshold: number
      readonly hitPercent: number
      readonly samplingSeconds: number
    }

/** The measurement behind a LEVEL-mode confirmation. Absent in label mode. */
export interface AudioWindowMeasurement {
  /** The MEASURED percentage of hits (≥ the spec's `hitPercent`). */
  readonly hitPercent: number
  /** Samples the window held. */
  readonly samples: number
  /** How many of them were hits. */
  readonly hits: number
  /** The window length, verbatim from the spec. */
  readonly samplingSeconds: number
}

/** A CONFIRMED match, emitted from {@link AudioWatcher.observe}. */
export interface AudioWindowHit {
  readonly deviceId: number
  /** The `now` at which it confirmed. */
  readonly timestamp: number
  /**
   * Labels behind the confirmation (sorted, normalized).
   *
   * LABEL mode: the watched labels this frame actually MATCHED — not every
   * label the frame carried, because the ones nobody asked for are not what
   * fired. LEVEL mode: the distinct labels observed on the hitting samples,
   * which is colour for the notification text and nothing more.
   */
  readonly labels: readonly string[]
  /** Loudest level among the hitting samples; absent when none carried one. */
  readonly peakDbfs?: number
  /** LEVEL mode only — the window that confirmed. */
  readonly window?: AudioWindowMeasurement
  /** The spec this confirmation belongs to, so the engine can pair rule↔hit. */
  readonly spec: AudioWindowSpec
}

/**
 * Fold a label onto ONE spelling: lower-cased, trimmed, `audio-` prefix
 * removed.
 *
 * The prefix exists because the NC taxonomy namespaces audio ids (`audio-dog`)
 * to keep them from colliding with the video class `dog`. A picker therefore
 * offers `audio-dog` while an operator typing by hand writes `dog`, and the
 * analyzer emits the bare macro class — three spellings of one sound. Folding
 * them here is the difference between a rule that matches and a rule that
 * silently never does.
 */
export function normalizeAudioLabel(label: string): string {
  const trimmed = label.trim().toLowerCase()
  return trimmed.startsWith('audio-') ? trimmed.slice('audio-'.length) : trimmed
}

/**
 * Map a rule condition onto a watched spec — and onto its MODE.
 *
 * The mode comes from `audioModeOf` in `@camstack/types`, the ONE place that
 * question is answered, so the engine, the editors and this matcher cannot
 * disagree about what a stored rule means. `null` means FAIL CLOSED: neither
 * filter was given, so every sample would be a hit and the rule would confirm
 * on silence.
 */
export function audioSpecFromCondition(condition: NcAudioCondition): AudioWindowSpec | null {
  const mode = audioModeOf(condition)
  if (mode === 'label') {
    return {
      mode: 'label',
      labels: [...new Set((condition.labels ?? []).map(normalizeAudioLabel))].sort(),
      confirmHits: condition.confirmHits ?? NC_AUDIO_CONFIRM_HITS_DEFAULT,
      confirmWindowSec: condition.confirmWindowSec ?? NC_AUDIO_CONFIRM_WINDOW_SEC_DEFAULT,
    }
  }
  // Re-read the threshold rather than trusting the mode to imply it: a
  // fallback constant here would be a level nobody authored.
  const dbThreshold = condition.dbThreshold
  if (mode === 'level' && dbThreshold !== undefined) {
    return {
      mode: 'level',
      dbThreshold,
      hitPercent: condition.hitPercent,
      samplingSeconds: condition.samplingSeconds,
    }
  }
  return null
}

/** Stable, device-agnostic key of a spec — rules that agree share a window. */
function audioSpecKey(spec: AudioWindowSpec): string {
  return spec.mode === 'label'
    ? `label|${spec.labels.join(',')}|c${String(spec.confirmHits)}|w${String(spec.confirmWindowSec)}`
    : `level|${String(spec.dbThreshold)}|h${String(spec.hitPercent)}|s${String(spec.samplingSeconds)}`
}

/**
 * The watched labels this sample carries, normalized and sorted. Empty = no
 * match, which in label mode is the whole verdict.
 */
function matchedAudioLabels(sample: AudioSample, labels: readonly string[]): readonly string[] {
  // BOTH sides are normalized here, not just the sample's. The spec is
  // supposed to arrive normalized from `audioSpecFromCondition`, and a spec
  // built anywhere else with a taxonomy id would otherwise match nothing at
  // all — a silent never-fires, which is the one failure mode audio rules
  // must not have.
  const wanted = new Set(labels.map(normalizeAudioLabel))
  const matched = new Set<string>()
  for (const carried of sample.labels) {
    const id = normalizeAudioLabel(carried)
    if (wanted.has(id)) matched.add(id)
  }
  return [...matched].sort()
}

/** Is this sample a hit for a LEVEL spec? */
function isAudioLevelHit(sample: AudioSample, dbThreshold: number): boolean {
  // Fail closed on a sample with no level: never guess how loud silence was.
  if (sample.dbfs === undefined || !Number.isFinite(sample.dbfs)) return false
  return sample.dbfs >= dbThreshold
}

/** In-RAM per-(device, spec) window. LEVEL mode only — label mode holds none. */
interface WindowState {
  /** When this key started collecting — the fullness clock (property 1). */
  openedAt: number
  /** Samples inside the window, oldest first. */
  samples: AudioSample[]
}

export class AudioWatcher {
  /** Watched specs, keyed by {@link audioSpecKey}. */
  private readonly watched = new Map<string, AudioWindowSpec>()
  /** LEVEL windows, keyed `${deviceId}|${specKey}`. */
  private readonly windows = new Map<string, WindowState>()
  /** LABEL pending hits, keyed `${deviceId}|${specKey}` — timestamps only. */
  private readonly labelHits = new Map<string, number[]>()

  /**
   * Replace the watched spec set (rule-driven — recomputed on every rule
   * reload). Windows whose spec is no longer watched are DROPPED: a rule
   * edited to a different threshold or window length is genuinely a different
   * question, and answering it with the old question's samples would confirm
   * on evidence nobody asked for.
   */
  setWatchedSpecs(specs: readonly AudioWindowSpec[]): void {
    this.watched.clear()
    for (const spec of specs) this.watched.set(audioSpecKey(spec), spec)
    for (const store of [this.windows, this.labelHits] as const) {
      for (const key of [...store.keys()]) {
        const specKey = key.slice(key.indexOf('|') + 1)
        if (!this.watched.has(specKey)) store.delete(key)
      }
    }
  }

  /** True when at least one spec is watched — the caller's cheap no-op gate. */
  get active(): boolean {
    return this.watched.size > 0
  }

  /**
   * Feed one audio sample for one camera at time `now`, returning the specs
   * that CONFIRM on this sample (usually none). Every watched spec is
   * evaluated for `deviceId`.
   */
  observe(deviceId: number, sample: AudioSample, now: number): readonly AudioWindowHit[] {
    if (this.watched.size === 0) return []
    const confirmed: AudioWindowHit[] = []
    for (const [specKey, spec] of this.watched) {
      const hit =
        spec.mode === 'label'
          ? this.observeLabel(deviceId, specKey, spec, sample, now)
          : this.observeLevel(deviceId, specKey, spec, sample, now)
      if (hit !== null) confirmed.push(hit)
    }
    return confirmed
  }

  /** Drop every window of a camera (unbound, removed, audio switched off). */
  forgetDevice(deviceId: number): void {
    const prefix = `${deviceId}|`
    for (const store of [this.windows, this.labelHits] as const) {
      for (const key of [...store.keys()]) {
        if (key.startsWith(prefix)) store.delete(key)
      }
    }
  }

  private observeLevel(
    deviceId: number,
    specKey: string,
    spec: Extract<AudioWindowSpec, { mode: 'level' }>,
    sample: AudioSample,
    now: number,
  ): AudioWindowHit | null {
    const key = `${deviceId}|${specKey}`
    const state = this.windows.get(key) ?? { openedAt: now, samples: [] }
    const windowMs = spec.samplingSeconds * 1000
    const cutoff = now - windowMs
    // Slide (property 2), then append. The window is HALF-OPEN —
    // `(now − samplingSeconds, now]` — so a sample exactly one window old has
    // aged out and is never counted twice at a boundary; at a 1 Hz cadence a
    // full 10 s window therefore holds 10 samples, not 11. A sample stamped in
    // the future of `now` is kept: the analyzer's frame timestamp is its own
    // clock and a small skew must not empty the window.
    const kept = state.samples.filter((s) => s.timestampMs > cutoff)
    kept.push(sample)
    state.samples = kept

    // Fullness by the OPEN clock, not by the span of what survives pruning.
    if (now - state.openedAt < windowMs || kept.length < MIN_WINDOW_SAMPLES) {
      this.windows.set(key, state)
      return null
    }

    let hits = 0
    let peakDbfs: number | undefined
    const labels = new Set<string>()
    for (const s of kept) {
      if (!isAudioLevelHit(s, spec.dbThreshold)) continue
      hits += 1
      if (
        s.dbfs !== undefined &&
        Number.isFinite(s.dbfs) &&
        (peakDbfs === undefined || s.dbfs > peakDbfs)
      ) {
        peakDbfs = s.dbfs
      }
      for (const l of s.labels) labels.add(normalizeAudioLabel(l))
    }
    const measured = (hits / kept.length) * 100
    if (measured < spec.hitPercent) {
      this.windows.set(key, state)
      return null
    }

    // Confirmed — re-arm (property 3).
    this.windows.set(key, { openedAt: now, samples: [] })
    return {
      deviceId,
      timestamp: now,
      ...(peakDbfs !== undefined ? { peakDbfs } : {}),
      labels: [...labels].sort(),
      window: {
        hitPercent: measured,
        samples: kept.length,
        hits,
        samplingSeconds: spec.samplingSeconds,
      },
      spec,
    }
  }

  /**
   * LABEL mode: confirm when `confirmHits` labelled frames land inside
   * `confirmWindowSec`. `confirmHits <= 1` is first-frame fire (stateless).
   * Confirming re-arms — the next episode needs a fresh count.
   */
  private observeLabel(
    deviceId: number,
    specKey: string,
    spec: Extract<AudioWindowSpec, { mode: 'label' }>,
    sample: AudioSample,
    now: number,
  ): AudioWindowHit | null {
    const matched = matchedAudioLabels(sample, spec.labels)
    if (matched.length === 0) return null
    const hit: AudioWindowHit = {
      deviceId,
      timestamp: now,
      labels: matched,
      ...(sample.dbfs !== undefined && Number.isFinite(sample.dbfs)
        ? { peakDbfs: sample.dbfs }
        : {}),
      spec,
    }
    if (spec.confirmHits <= 1) return hit

    const key = `${deviceId}|${specKey}`
    const cutoff = now - spec.confirmWindowSec * 1000
    const kept = (this.labelHits.get(key) ?? []).filter((at) => at > cutoff)
    kept.push(now)
    if (kept.length < spec.confirmHits) {
      this.labelHits.set(key, kept)
      return null
    }
    this.labelHits.delete(key)
    return hit
  }
}
