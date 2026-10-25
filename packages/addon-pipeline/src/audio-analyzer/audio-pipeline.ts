/**
 * Audio classification pipeline.
 *
 * - macOS: Apple SoundAnalysis framework (303 built-in sound categories)
 * - Cross-platform: YAMNet ONNX via an embedded-Python subprocess
 *   (`yamnet_audio.py`, onnxruntime) — the hub ships no Node ONNX runtime.
 *
 * This is independent from the video pipeline — different input (audio samples),
 * different engine, different output cadence. Both backends talk to a
 * persistent subprocess over the same length-prefixed wire protocol.
 */
import type { IScopedLogger } from '@camstack/types'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { errMsg } from '@camstack/types'
// eslint-disable-next-line no-restricted-imports -- `ensureModel` is a build-time dep, the same waiver detection-pipeline and the embedding encoder use for the shared model downloader in `@camstack/system`.
import { ensureModel } from '@camstack/system/addon-utils'
import { AUDIO_CLASSIFIER_MODELS } from '../detection-pipeline/registry/model-catalogs.js'
import { AudioSubprocessChannel, parseClassifyReply } from './audio-subprocess-channel.js'

// `__dirname` is shimmed by tsup (`shims: true`) for both CJS and ESM
// output, so it works whether this bundle is loaded by `require` or by
// `await import(...)` (the agent path).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioClassificationResult {
  readonly classifications: readonly {
    readonly className: string
    readonly score: number
  }[]
  readonly inferenceMs: number
}

export interface AudioChunk {
  readonly data: Float32Array
  readonly sampleRate: number
  readonly channels: number
}

export interface IAudioPipeline {
  initialize(): Promise<void>
  classify(chunk: AudioChunk): Promise<AudioClassificationResult>
  dispose(): Promise<void>
  /** Native pid of the inference subprocess, if spawned — sampled by the
   *  pool memory watchdog (`/proc/<pid>/status`). */
  getPid(): number | null
}

export type AudioBackend = 'yamnet-onnx' | 'apple-soundanalysis'

export interface AudioPipelineOptions {
  readonly backend?: AudioBackend
  /**
   * Absolute path to the embedded portable Python interpreter
   * (`ctx.deps.ensurePython()`). REQUIRED for the cross-platform
   * 'yamnet-onnx' backend; ignored for 'apple-soundanalysis'.
   */
  readonly pythonPath?: string
  /**
   * Installs a pip requirements file into the embedded interpreter
   * (`ctx.deps.installPythonRequirements`). Called once with the audio
   * requirements before the YAMNet subprocess is spawned.
   */
  readonly installPythonRequirements?: (requirementsFile: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the appropriate audio pipeline.
 *
 * - 'yamnet-onnx': Cross-platform YAMNet ONNX via embedded Python (requires
 *   model download + `options.pythonPath`)
 * - 'apple-soundanalysis': macOS 12+ Apple SoundAnalysis (zero model download, Neural Engine)
 * - undefined: auto-detect (Apple SA on macOS, YAMNet on Linux)
 */
export async function createAudioPipeline(
  modelsDir: string,
  logger: IScopedLogger,
  options?: AudioPipelineOptions,
): Promise<IAudioPipeline> {
  const backend =
    options?.backend ?? (process.platform === 'darwin' ? 'apple-soundanalysis' : 'yamnet-onnx')

  if (backend === 'apple-soundanalysis') {
    return new AppleSoundAnalysisPipeline(logger)
  }
  if (!options?.pythonPath) {
    throw new Error(
      'YAMNet audio backend requires the embedded Python interpreter — pass ' +
        'options.pythonPath (ctx.deps.ensurePython()).',
    )
  }
  return new YamnetPythonPipeline(
    modelsDir,
    logger,
    options.pythonPath,
    options.installPythonRequirements,
  )
}

// ---------------------------------------------------------------------------
// YAMNet via embedded Python (cross-platform)
// ---------------------------------------------------------------------------

/** Where the YAMNet subprocess finds its model and its labels. */
export interface YamnetFiles {
  readonly modelPath: string
  readonly labelsPath: string
}

const YAMNET_MODEL_ID = 'yamnet-onnx'

/**
 * Materialise the YAMNet ONNX model and its labels from the catalog entry,
 * through `ensureModel` — the one download path every hosted artefact takes,
 * so a copy the mirror replaced in place is fetched again (D743, D744).
 */
export async function ensureYamnetFiles(modelsDir: string): Promise<YamnetFiles> {
  const entry = AUDIO_CLASSIFIER_MODELS.find((m) => m.id === YAMNET_MODEL_ID)
  if (entry === undefined) throw new Error(`audio catalog has no ${YAMNET_MODEL_ID} entry`)
  const labels = entry.extraFiles?.[0]
  if (labels === undefined) throw new Error(`${YAMNET_MODEL_ID} declares no labels file`)
  const modelPath = await ensureModel(modelsDir, entry, 'onnx')
  return { modelPath, labelsPath: path.join(modelsDir, labels.filename) }
}

/**
 * Locate the addon's bundled `python/` dir (holds `yamnet_audio.py` +
 * `requirements-audio.txt`). Mirrors detection-pipeline's resolver: the
 * published package first, then `__dirname`-relative candidates for the
 * in-tree dev build. This file compiles to `dist/audio-analyzer/index.*`,
 * so the bundle's `python/` is `../../python`.
 */
function resolveAudioPythonDir(): string {
  const candidates: string[] = []
  try {
    const pkgPath = require.resolve('@camstack/addon-pipeline/package.json')
    candidates.push(path.join(path.dirname(pkgPath), 'python'))
  } catch {
    // not resolvable in-tree before npm install
  }
  candidates.push(
    path.join(__dirname, '../../python'),
    path.join(__dirname, '../python'),
    path.join(__dirname, '../../../python'),
  )
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'yamnet_audio.py'))) return c
  }
  throw new Error(
    `audio-analyzer: python/ dir (yamnet_audio.py) not found. Searched:\n${candidates.join('\n')}`,
  )
}

/**
 * YAMNet ONNX inference via a persistent embedded-Python subprocess
 * (`yamnet_audio.py`). Replaces the former onnxruntime-node path so the hub
 * ships no Node ONNX runtime. Wire protocol = length-prefixed frames
 * ([4B LE length][payload]), matching the Apple SoundAnalysis CLI: outbound
 * payload is the raw float32 16 kHz-mono waveform, inbound is a JSON result.
 */
class YamnetPythonPipeline implements IAudioPipeline {
  private readonly log: IScopedLogger
  /** The wire + reply slot; settles a waiting request on ANY exit (D660). */
  private readonly channel: AudioSubprocessChannel

  constructor(
    private readonly modelsDir: string,
    logger: IScopedLogger,
    private readonly pythonPath: string,
    private readonly installPythonRequirements?: (requirementsFile: string) => Promise<void>,
  ) {
    this.log = logger
    this.channel = new AudioSubprocessChannel('YAMNet Python', logger)
  }

  async initialize(): Promise<void> {
    // Fetches the model + labels when absent or not at the mirror's revision;
    // a no-op for a current copy.
    const { modelPath, labelsPath } = await ensureYamnetFiles(this.modelsDir)
    this.log.info('YAMNet model ready', {
      meta: { modelPath, sizeBytes: fs.statSync(modelPath).size },
    })

    const pythonDir = resolveAudioPythonDir()
    if (this.installPythonRequirements) {
      await this.installPythonRequirements(path.join(pythonDir, 'requirements-audio.txt'))
    }

    const scriptPath = path.join(pythonDir, 'yamnet_audio.py')
    const { spawn } = await import('node:child_process')
    const proc = spawn(
      this.pythonPath,
      [scriptPath, '--model', modelPath, '--labels', labelsPath],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.log.warn(text)
    })
    this.channel.attach(proc)

    const ready = await this.channel.receive()
    if (ready['status'] !== 'ready') {
      throw new Error(`YAMNet Python: unexpected init response: ${JSON.stringify(ready)}`)
    }
    this.log.info(`YAMNet Python pipeline initialized (${String(ready['labels'] ?? '?')} labels)`)
  }

  getPid(): number | null {
    return this.channel.pid
  }

  async classify(chunk: AudioChunk): Promise<AudioClassificationResult> {
    const waveform =
      chunk.sampleRate === 16000 && chunk.channels === 1 ? chunk.data : resampleMono16k(chunk)
    const reply = await this.channel.request(
      Buffer.from(waveform.buffer, waveform.byteOffset, waveform.byteLength),
    )
    return parseClassifyReply('YAMNet Python', reply)
  }

  async dispose(): Promise<void> {
    await this.channel.dispose()
  }
}

// ---------------------------------------------------------------------------
// Apple SoundAnalysis (macOS)
// ---------------------------------------------------------------------------

class AppleSoundAnalysisPipeline implements IAudioPipeline {
  private readonly log: IScopedLogger
  /** The wire + reply slot; settles a waiting request on ANY exit (D660). */
  private readonly channel: AudioSubprocessChannel
  private binaryPath: string | null = null
  private debugCount = 0

  constructor(logger: IScopedLogger) {
    this.log = logger
    this.channel = new AudioSubprocessChannel('Apple SoundAnalysis', logger)
  }

  async initialize(): Promise<void> {
    this.binaryPath = await this.resolveSwiftBinary()
    if (!this.binaryPath) {
      throw new Error(
        'Apple SoundAnalysis: Swift CLI not found and compilation failed. macOS with Xcode CLI tools required.',
      )
    }

    const { spawn } = await import('node:child_process')
    const proc = spawn(this.binaryPath, ['--sample-rate=16000', '--top-k=10'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed) this.log.warn(trimmed)
      }
    })
    this.channel.attach(proc)

    const ready = await this.channel.receive()
    if (ready['status'] !== 'ready') {
      throw new Error(`Apple SoundAnalysis: unexpected init response: ${JSON.stringify(ready)}`)
    }
    this.log.info('Apple SoundAnalysis pipeline initialized (macOS built-in, Swift CLI bridge)')
  }

  getPid(): number | null {
    return this.channel.pid
  }

  async classify(chunk: AudioChunk): Promise<AudioClassificationResult> {
    const waveform =
      chunk.sampleRate === 16000 && chunk.channels === 1 ? chunk.data : resampleMono16k(chunk)
    const audioBuffer = Buffer.from(waveform.buffer, waveform.byteOffset, waveform.byteLength)
    const reply = await this.channel.request(audioBuffer)
    if (this.debugCount < 3) {
      this.log.info('classify debug sample', {
        meta: {
          phase: 'apple-sa',
          index: this.debugCount,
          keys: Object.keys(reply),
          audioBytes: audioBuffer.length,
          sampleRate: chunk.sampleRate,
          channels: chunk.channels,
        },
      })
      this.debugCount++
    }
    // A reply carrying `error` throws here — a failed inference, never silence (D660).
    return parseClassifyReply('Apple SoundAnalysis', reply)
  }

  async dispose(): Promise<void> {
    await this.channel.dispose()
  }

  /** Find pre-compiled binary or compile from Swift source. */
  private async resolveSwiftBinary(): Promise<string | null> {
    // Phase D bundle merge: audio-analyzer ships inside
    // `@camstack/addon-pipeline/dist/audio-analyzer/`, with swift
    // sources at the bundle's `swift/audio-analyzer/` sub-folder.
    // From `dist/audio-analyzer/index.js`, that's `../../swift/audio-analyzer`.
    const candidates = [
      path.join(__dirname, '../../swift/audio-analyzer/apple-sound-classifier'),
      // Fallback for in-tree dev (src/<id>/swift/) and pre-merge layouts.
      path.join(__dirname, '../swift/apple-sound-classifier'),
      path.join(__dirname, '../../swift/apple-sound-classifier'),
      path.join(__dirname, '../../../swift/apple-sound-classifier'),
    ]

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        this.log.info('Found pre-compiled Swift CLI', { meta: { path: p } })
        return p
      }
    }

    const sourceCandidates = [
      path.join(__dirname, '../../swift/audio-analyzer/apple-sound-classifier.swift'),
      path.join(__dirname, '../swift/apple-sound-classifier.swift'),
      path.join(__dirname, '../../swift/apple-sound-classifier.swift'),
      path.join(__dirname, '../../../swift/apple-sound-classifier.swift'),
    ]
    const sourcePath = sourceCandidates.find((p) => fs.existsSync(p))
    if (!sourcePath) {
      this.log.error('Swift source not found', { meta: { searched: sourceCandidates } })
      return null
    }

    const outputPath = sourcePath.replace('.swift', '')
    this.log.info('Compiling Swift CLI...', { meta: { source: sourcePath, output: outputPath } })

    const { execFileSync } = await import('node:child_process')
    try {
      execFileSync('swiftc', ['-O', '-o', outputPath, sourcePath], {
        timeout: 60_000,
        stdio: 'pipe',
      })
      this.log.info('Swift CLI compiled successfully')
      return outputPath
    } catch (err) {
      this.log.error('Swift compilation failed — install Xcode Command Line Tools', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/**
 * Resample to 16 kHz mono by linear interpolation — the ONE place a window
 * is brought to the classifier's rate. The plane carries the source rate
 * (8 kHz for G.711, D450); the model that needs 16 kHz gets it here, next to
 * the model, over a whole window. Exported so the guard can pin it.
 */
export function resampleMono16k(chunk: AudioChunk): Float32Array {
  const { data, sampleRate, channels } = chunk
  const numSamples = data.length / channels

  // Mix to mono
  const mono = new Float32Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      sum += data[i * channels + c]!
    }
    mono[i] = sum / channels
  }

  // Resample to 16kHz
  const ratio = 16000 / sampleRate
  const outLen = Math.floor(numSamples * ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i / ratio
    const lo = Math.floor(srcIdx)
    const hi = Math.min(lo + 1, numSamples - 1)
    const frac = srcIdx - lo
    out[i] = mono[lo]! * (1 - frac) + mono[hi]! * frac
  }
  return out
}
