/**
 * Triage: turn a window of tracks into a ranked list of suspects.
 *
 * Pure. The scoring looks only at what the track record already carries — it
 * never decides a track is wrong, it ranks which ones a reviewer should LOOK
 * at first. A track that scores zero is not "correct", which is why every run
 * also returns a random control sample of non-suspects: the reviewer looks at
 * those too, and the share that turns out wrong is the miss rate of the signals.
 */
import { COCO_TO_MACRO } from '@camstack/types'
import type { TriageTrack } from './hub-api.js'
import { inTrainingOf, type InTraining, type TrainingMembership } from './training.js'

export const TRIAGE_SIGNALS = [
  'class-label-mismatch',
  'low-label-score',
  'suspect-label',
  'very-short',
  'few-observations',
  'tiny-subject',
  'static-subject',
  'class-changed',
] as const
export type TriageSignal = (typeof TRIAGE_SIGNALS)[number]

/** Points each signal adds to a track's score. */
export const SIGNAL_WEIGHTS: Readonly<Record<TriageSignal, number>> = {
  'class-label-mismatch': 3,
  'low-label-score': 2,
  'suspect-label': 2,
  'very-short': 1,
  'few-observations': 1,
  'tiny-subject': 1,
  'static-subject': 1,
  'class-changed': 1,
}

export interface TriageOptions {
  /** Sub-labels that small or unusual subjects are commonly mistaken for. */
  readonly suspectLabels: readonly string[]
  /** A label score below this is weak (`low-label-score`). */
  readonly lowLabelScore: number
  /** A track shorter than this is `very-short`. */
  readonly shortMs: number
  /** A track with fewer position samples than this has `few-observations`. */
  readonly fewObservations: number
  /** An envelope covering less than this fraction of the frame is `tiny-subject`. */
  readonly tinyAreaFraction: number
  /** Smallest score that makes a track a suspect. */
  readonly minScore: number
}

export const DEFAULT_TRIAGE_OPTIONS: TriageOptions = {
  suspectLabels: ['cat', 'bird', 'teddy bear', 'sheep'],
  lowLabelScore: 0.6,
  shortMs: 500,
  fewObservations: 3,
  tinyAreaFraction: 0.004,
  minScore: 3,
}

export interface TriageFeatures {
  readonly trackId: string
  readonly deviceId: number
  readonly className: string
  readonly label: string | null
  readonly labelScore: number | null
  readonly durationMs: number
  readonly observations: number | null
  readonly moved: boolean
  readonly envelopeArea: number | null
  readonly classes: readonly string[]
  readonly hasFace: boolean
  readonly hasRider: boolean
  readonly firstSeen: number
}

export interface ScoredTrack {
  readonly features: TriageFeatures
  /** The camera's display name; absent when the camera list did not name it. */
  readonly cameraName?: string
  /** Already has a frame in the retrain corpus, and in which collections. */
  readonly inTraining: InTraining | null
  readonly score: number
  readonly signals: readonly TriageSignal[]
}

const MOVED_DISTANCE = 0.05

function macroOfLabel(label: string): string | undefined {
  const mapping: Readonly<Record<string, string | undefined>> = COCO_TO_MACRO.mapping
  return mapping[label.trim().toLowerCase()]
}

export function extractFeatures(track: TriageTrack): TriageFeatures {
  const env = track.envelope
  const area = env ? Math.max(0, env.maxX - env.minX) * Math.max(0, env.maxY - env.minY) : null
  const samples = track.positions?.length ?? 0
  return {
    trackId: track.trackId,
    deviceId: track.deviceId,
    className: track.className,
    label: track.label ?? null,
    labelScore: track.labelScore ?? null,
    durationMs: Math.max(0, track.lastSeen - track.firstSeen),
    // Slim rows carry no positions: unknown is `null`, never 0.
    observations: samples > 0 ? samples : null,
    moved: track.totalDistance >= MOVED_DISTANCE,
    envelopeArea: area,
    classes: track.classes ?? [track.className],
    hasFace: track.hasFace === true,
    hasRider: track.hasRider === true,
    firstSeen: track.firstSeen,
  }
}

/** The signals one track raises. Each has a stated reason in the skill. */
export function detectSignals(f: TriageFeatures, o: TriageOptions): readonly TriageSignal[] {
  const out: TriageSignal[] = []
  if (f.label !== null) {
    const macro = macroOfLabel(f.label)
    if (macro !== undefined && macro !== f.className) out.push('class-label-mismatch')
    if (o.suspectLabels.includes(f.label.toLowerCase())) out.push('suspect-label')
  }
  if (f.labelScore !== null && f.labelScore < o.lowLabelScore) out.push('low-label-score')
  if (f.durationMs < o.shortMs) out.push('very-short')
  if (f.observations !== null && f.observations < o.fewObservations) out.push('few-observations')
  if (f.envelopeArea !== null && f.envelopeArea < o.tinyAreaFraction) out.push('tiny-subject')
  // A person or vehicle that never moves and was not parked is the profile of
  // a picture of one (a screen, a poster) — worth a look, not a verdict.
  if (!f.moved && (f.className === 'vehicle' || f.className === 'person') && f.durationMs > 0) {
    out.push('static-subject')
  }
  if (f.classes.length > 1) out.push('class-changed')
  return out
}

export function scoreTrack(track: TriageTrack, o: TriageOptions): ScoredTrack {
  const features = extractFeatures(track)
  const signals = detectSignals(features, o)
  const score = signals.reduce((sum, s) => sum + SIGNAL_WEIGHTS[s], 0)
  return { features, inTraining: null, score, signals }
}

/** What triage knows besides the tracks themselves. */
export interface TriageContext {
  readonly cameraNames: Readonly<Record<number, string>>
  /** Absent = membership was not read; nothing is marked or skipped. */
  readonly training?: TrainingMembership
  /** Drop suspects that are already in the corpus (counted in the result). */
  readonly excludeInTraining: boolean
}

const NO_CONTEXT: TriageContext = { cameraNames: {}, excludeInTraining: false }

export interface TriageResult {
  readonly examined: number
  readonly suspectCount: number
  /** Highest score first, ties by newest; capped at `maxSuspects`. */
  readonly suspects: readonly ScoredTrack[]
  /** Random non-suspects, for the miss-rate check. */
  readonly control: readonly ScoredTrack[]
  /** The class/label combinations most often flagged, to guide the reviewer. */
  readonly bySuspectLabel: Readonly<Record<string, number>>
  /** Suspects left out because they already have a frame in the corpus. */
  readonly skippedInTraining: number
  /** The corpus read stopped early: `inTraining: null` is then not proof. */
  readonly trainingTruncated: boolean
  /**
   * Signals NOT evaluated here. The slim rows triage reads carry no position
   * history, so `few-observations` cannot be computed without a call per
   * track, which triage never makes. `track_review_frame` evaluates it.
   */
  readonly signalsNotEvaluated: readonly TriageSignal[]
}

export interface TriageLimits {
  readonly maxSuspects: number
  readonly controlSize: number
}

/**
 * Partition into suspects and the rest, rank, and sample a control group.
 * `random` is injected so a test (or a reproducible audit) can fix the sample.
 */
export function triageTracks(
  tracks: readonly TriageTrack[],
  options: TriageOptions,
  limits: TriageLimits,
  random: () => number,
  context: TriageContext = NO_CONTEXT,
): TriageResult {
  const seen = new Set<string>()
  const scored: ScoredTrack[] = []
  for (const t of tracks) {
    if (seen.has(t.trackId)) continue
    seen.add(t.trackId)
    // Synthetic (sensor-derived) tracks have no detector class to be wrong.
    if (t.source !== undefined && t.source !== 'pipeline') continue
    const base = scoreTrack(t, options)
    const name = context.cameraNames[t.deviceId]
    scored.push({
      ...base,
      ...(name !== undefined ? { cameraName: name } : {}),
      inTraining: context.training ? inTrainingOf(t.trackId, context.training) : null,
    })
  }
  const flagged = scored
    .filter((s) => s.score >= options.minScore)
    .sort((a, b) => b.score - a.score || b.features.firstSeen - a.features.firstSeen)
  const suspects = context.excludeInTraining
    ? flagged.filter((s) => s.inTraining === null)
    : flagged
  const rest = scored.filter((s) => s.score < options.minScore)
  const bySuspectLabel: Record<string, number> = {}
  for (const s of suspects) {
    const key = `${s.features.className}/${s.features.label ?? '-'}`
    bySuspectLabel[key] = (bySuspectLabel[key] ?? 0) + 1
  }
  return {
    examined: scored.length,
    suspectCount: suspects.length,
    suspects: suspects.slice(0, limits.maxSuspects),
    control: sample(rest, limits.controlSize, random),
    bySuspectLabel,
    skippedInTraining: flagged.length - suspects.length,
    trainingTruncated: context.training?.truncated === true,
    signalsNotEvaluated: scored.every((s) => s.features.observations === null)
      ? ['few-observations']
      : [],
  }
}

/** Fisher-Yates over a copy: `n` distinct items, uniformly. */
export function sample<T>(items: readonly T[], n: number, random: () => number): readonly T[] {
  const pool = [...items]
  const take = Math.min(Math.max(0, n), pool.length)
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(random() * (pool.length - i))
    const a = pool[i]!
    pool[i] = pool[j]!
    pool[j] = a
  }
  return pool.slice(0, take)
}
