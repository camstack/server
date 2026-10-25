/**
 * Audio bench payload + debug-selection tests.
 *
 * ⚠️ The fixture in this file is NOT hand-written. It is derived from the
 * literal the PRODUCERS write, read off their source at test time:
 *
 *   - bench path: `packages/addon-pipeline/src/detection-pipeline/provider.ts`
 *   - live path:  `packages/addon-pipeline-orchestrator/src/audio-window-accumulator.ts`
 *
 * That is deliberate and it is the whole point of this spec. The bug this
 * replaces — the UI reading `audio-classifier` while both producers wrote
 * `audio-analyzer`, leaving the Classifications panel and the inference
 * timing permanently empty — would have passed a hand-written fixture keyed
 * `audio-classifier`. A green test over an invented fixture is how that bug
 * survived to production. Reading the producer means the fixture cannot
 * agree with a wrong consumer.
 *
 * Path-anchoring is deliberate too: if either producer moves, this fails
 * loudly rather than quietly checking nothing.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AudioResult, ScoredLabel } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AUDIO_DEBUG_SOURCE, buildAudioRunInput, selectAudioDebug } from '../audio-payloads.js'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const BENCH_PRODUCER = path.join(
  REPO_ROOT,
  'packages/addon-pipeline/src/detection-pipeline/provider.ts',
)
/**
 * Moved by D461, when the analyzer took over pulling its own audio and the
 * orchestrator kept only the policy. This guard kept pointing at the old path
 * and so has been failing since 1.2.271 - `readFileSync` on a path that does
 * not exist, which reads as "the producer changed its key" and is not that.
 *
 * A cross-package guard addressed by PATH is only as good as the last move
 * nobody updated. If this breaks again, the fix is to make the producer export
 * the literal and import it here, not to chase the path a third time.
 */
const LIVE_PRODUCER = path.join(
  REPO_ROOT,
  'packages/addon-pipeline/src/audio-analyzer/audio-window-accumulator.ts',
)

/**
 * Read the debug-source literal a producer writes into its `stepTimings`
 * array. Both producers spell it as `source: '<key>'` inside the audio
 * result they build.
 */
function readProducedSource(file: string): string {
  const src = readFileSync(file, 'utf8')
  const matches = [...src.matchAll(/source:\s*'([a-z0-9-]+)'/g)]
    .map((m) => m[1])
    .filter((s): s is string => s !== undefined && s.startsWith('audio-'))
  const unique = [...new Set(matches)]
  expect(unique, `expected exactly one audio-* stepTimings source literal in ${file}`).toHaveLength(
    1,
  )
  return unique[0]!
}

describe('audio debug key — one owner', () => {
  it('the bench producer writes the key the UI reads', () => {
    expect(readProducedSource(BENCH_PRODUCER)).toBe(AUDIO_DEBUG_SOURCE)
  })

  it('the live producer writes the same key', () => {
    expect(readProducedSource(LIVE_PRODUCER)).toBe(AUDIO_DEBUG_SOURCE)
  })

  it('the bench producer keys `alternateLabels` with it too', () => {
    const src = readFileSync(BENCH_PRODUCER, 'utf8')
    const block = src.slice(src.indexOf('alternateLabels: {'))
    expect(block.slice(0, 120)).toContain(`'${AUDIO_DEBUG_SOURCE}'`)
  })
})

/**
 * The producer's shape, rebuilt with the key READ from the producer — never
 * typed by hand. Mirrors the `AudioResult` assembled in `runAudioTest`.
 */
function producerFixture(): AudioResult {
  const key = readProducedSource(BENCH_PRODUCER)
  const alternateTopN: readonly ScoredLabel[] = [
    { label: 'dog', score: 0.81 },
    { label: 'speech', score: 0.12 },
  ]
  return {
    kind: 'audio-window',
    windowId: 'audio-test-1',
    deviceId: 0,
    timestamp: 1,
    startMs: 0,
    endMs: 960,
    detections: [
      {
        id: 'a1',
        kind: 'audio',
        startMs: 0,
        endMs: 960,
        macroClass: 'dog',
        score: 0.81,
        labels: [],
        debug: {
          stepLatencyMs: { [key]: 12.5 },
          modelIds: { [key]: 'yamnet' },
          alternateLabels: { [key]: alternateTopN },
        },
      },
    ],
    debug: {
      totalInferenceMs: 18.25,
      stepTimings: [{ source: key, modelId: 'yamnet', ms: 12.5, detectionCount: 1 }],
      engine: 'audio-analyzer',
    },
  }
}

describe('selectAudioDebug', () => {
  it('returns the ranked labels and the inference ms from the producer shape', () => {
    const sel = selectAudioDebug(producerFixture())
    expect(sel.alternateTopN.map((l) => l.label)).toEqual(['dog', 'speech'])
    expect(sel.inferenceMs).toBe(12.5)
    expect(sel.totalMs).toBe(18.25)
  })

  it('is empty and undefined for a missing frame', () => {
    const sel = selectAudioDebug(undefined)
    expect(sel.alternateTopN).toEqual([])
    expect(sel.inferenceMs).toBeUndefined()
    expect(sel.totalMs).toBeUndefined()
  })
})

describe('buildAudioRunInput', () => {
  it('sends the selected reference filename', () => {
    const input = buildAudioRunInput({
      nodeId: 'hub',
      addonId: 'audio-analyzer',
      filename: 'bark.wav',
      settings: {},
    })
    expect(input).toEqual({
      nodeId: 'hub',
      addonId: 'audio-analyzer',
      modelId: '',
      filename: 'bark.wav',
    })
  })

  it('carries per-step settings when the operator changed one', () => {
    const input = buildAudioRunInput({
      nodeId: 'hub',
      addonId: 'audio-analyzer',
      filename: 'bark.wav',
      settings: { minScore: 0.4 },
    })
    expect(input.settings).toEqual({ minScore: 0.4 })
  })

  /**
   * `runAudioTest` has NO field for an uploaded WAV — it takes
   * `{addonId, modelId, filename?, settings?}` only. An upload path could
   * therefore only ever produce a payload with NO filename, which makes the
   * provider fall back to the FIRST reference WAV in its directory: the
   * operator uploads one file and is shown a confident classification of a
   * different one. There must be no way to build that payload.
   */
  it('never builds a payload without a filename', () => {
    expect(() =>
      buildAudioRunInput({
        nodeId: 'hub',
        addonId: 'audio-analyzer',
        filename: '',
        settings: {},
      }),
    ).toThrowError(/reference file/i)
  })
})
