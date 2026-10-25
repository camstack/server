// ---------------------------------------------------------------------------
// audio-level-detector — pure per-device loudness-peak / heartbeat decision
// for the analytics "level" audio events. No I/O. The caller keeps one
// LevelState per device and feeds it each audio frame's dBFS.
//
// Policy ("both"): within each maxWait window emit at most one level event —
// the first significant peak (dbfs >= rollingMean + deviationDb) respecting a
// cooldown == maxWait since the last peak, OR a heartbeat sample once maxWait
// elapses since the last emission with audible audio. Frames below the silence
// floor never emit.
// ---------------------------------------------------------------------------

export interface LevelConfig {
  readonly windowMs: number
  readonly deviationDb: number
  readonly maxWaitMs: number
  readonly silenceFloorDbfs: number
}

export interface LevelSample {
  readonly timestampMs: number
  readonly dbfs: number
}

export interface LevelState {
  /** Rolling window of recent samples (ascending by time). */
  readonly samples: readonly LevelSample[]
  /** Timestamp of the last emitted event of any kind (peak or heartbeat), or null. */
  readonly lastEmitMs: number | null
  /** Timestamp of the last emitted peak event, or null. */
  readonly lastPeakMs: number | null
}

export type LevelReason = 'peak' | 'heartbeat'

export interface LevelResult {
  readonly emit: boolean
  readonly reason: LevelReason | null
  /** Rolling mean dBFS over the window (after adding the current sample). */
  readonly mean: number
  readonly nextState: LevelState
}

export function emptyLevelState(): LevelState {
  return { samples: [], lastEmitMs: null, lastPeakMs: null }
}

export function observeLevel(
  state: LevelState,
  sample: LevelSample,
  cfg: LevelConfig,
): LevelResult {
  // Drop samples older than the window, then append the current one.
  const cutoff = sample.timestampMs - cfg.windowMs
  const kept = state.samples.filter((s) => s.timestampMs >= cutoff)
  const windowSamples = [...kept, sample]
  const mean = windowSamples.reduce((acc, s) => acc + s.dbfs, 0) / windowSamples.length

  const audible = sample.dbfs > cfg.silenceFloorDbfs
  if (!audible) {
    return {
      emit: false,
      reason: null,
      mean,
      nextState: {
        samples: windowSamples,
        lastEmitMs: state.lastEmitMs,
        lastPeakMs: state.lastPeakMs,
      },
    }
  }

  // Compare the peak against the PRIOR baseline (exclude the current frame) so a
  // lone spike isn't diluted by itself; fall back to the mean when no history.
  const priorMean = kept.length > 0 ? kept.reduce((acc, s) => acc + s.dbfs, 0) / kept.length : mean
  const isPeak = sample.dbfs >= priorMean + cfg.deviationDb

  // Peaks respect a cooldown measured from the last peak emission.
  const sincePeak =
    state.lastPeakMs === null ? Number.POSITIVE_INFINITY : sample.timestampMs - state.lastPeakMs
  const peakCooldownOk = sincePeak >= cfg.maxWaitMs

  // Heartbeats respect a cooldown measured from any prior emission (peak or heartbeat).
  const sinceLastEmit =
    state.lastEmitMs === null ? Number.POSITIVE_INFINITY : sample.timestampMs - state.lastEmitMs
  const heartbeatCooldownOk = sinceLastEmit >= cfg.maxWaitMs

  let reason: LevelReason | null = null
  if (isPeak && peakCooldownOk) reason = 'peak'
  else if (!isPeak && heartbeatCooldownOk) reason = 'heartbeat'

  const emit = reason !== null
  const nextLastEmitMs = emit ? sample.timestampMs : state.lastEmitMs
  const nextLastPeakMs = reason === 'peak' ? sample.timestampMs : state.lastPeakMs

  return {
    emit,
    reason,
    mean,
    nextState: { samples: windowSamples, lastEmitMs: nextLastEmitMs, lastPeakMs: nextLastPeakMs },
  }
}
