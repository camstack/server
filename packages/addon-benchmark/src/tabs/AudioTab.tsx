import type {
  AudioResult,
  ConfigField,
  PipelineAddonSchema,
  PipelineSchema,
  ScoredLabel,
} from '@camstack/types'
import { useState, useEffect, useCallback, useMemo } from 'react'
import type { AddonPageProps } from '@camstack/ui-library'
import {
  AudioWaveform,
  ImageSelector,
  NodePicker,
  ResponseLog,
  SectionToolbar,
  Button,
  Slider,
  Select,
} from '@camstack/ui-library'
import { buildAudioRunInput, selectAudioDebug } from '../audio-payloads.js'
import { Trans, useT } from '../i18n/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReferenceAudioFile {
  readonly filename: string
  readonly sizeKb: number
}

/**
 * Envelope returned by `pipelineExecutor.runAudioTest`. Matches
 * `AudioTestResultSchema` in `pipeline-executor.cap.ts` — the post
 * Phase 6 rework shape that carries a canonical `AudioResult` (with
 * `AudioDetection[]`, `debug.alternateLabels`, `debug.stepTimings`)
 * instead of the legacy ad-hoc `{labels: [{className, ...}]}` list.
 */
interface AudioTestEnvelope {
  readonly success: boolean
  readonly error?: string
  readonly frame?: AudioResult
}

// ---------------------------------------------------------------------------
// WAV Decoder (client-side for waveform display)
// ---------------------------------------------------------------------------

function decodeWavSamples(base64: string): Float32Array | null {
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const buf = bytes.buffer

    const view = new DataView(buf)
    const audioFormat = view.getUint16(20, true)
    const channels = view.getUint16(22, true)
    const bitsPerSample = view.getUint16(34, true)

    // Find data chunk
    let offset = 36
    while (offset < buf.byteLength - 8) {
      const chunkId = String.fromCharCode(
        bytes[offset]!,
        bytes[offset + 1]!,
        bytes[offset + 2]!,
        bytes[offset + 3]!,
      )
      const chunkSize = view.getUint32(offset + 4, true)
      if (chunkId === 'data') {
        offset += 8
        const dataEnd = Math.min(offset + chunkSize, buf.byteLength)

        if (audioFormat === 3 && bitsPerSample === 32) {
          const numSamples = (dataEnd - offset) / 4
          const samples = new Float32Array(numSamples)
          for (let i = 0; i < numSamples; i++) {
            samples[i] = view.getFloat32(offset + i * 4, true)
          }
          // Mix to mono
          if (channels > 1) {
            const mono = new Float32Array(numSamples / channels)
            for (let i = 0; i < mono.length; i++) {
              let sum = 0
              for (let c = 0; c < channels; c++) sum += samples[i * channels + c]!
              mono[i] = sum / channels
            }
            return mono
          }
          return samples
        } else if (audioFormat === 1 && bitsPerSample === 16) {
          const numSamples = (dataEnd - offset) / 2
          const samples = new Float32Array(numSamples)
          for (let i = 0; i < numSamples; i++) {
            samples[i] = view.getInt16(offset + i * 2, true) / 32768
          }
          if (channels > 1) {
            const mono = new Float32Array(numSamples / channels)
            for (let i = 0; i < mono.length; i++) {
              let sum = 0
              for (let c = 0; c < channels; c++) sum += samples[i * channels + c]!
              mono[i] = sum / channels
            }
            return mono
          }
          return samples
        }
        return null
      }
      offset += 8 + chunkSize
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Audio Tab
// ---------------------------------------------------------------------------

export function AudioTab({
  trpc,
  nodeId,
  onNodeChange,
}: {
  trpc: AddonPageProps['trpc']
  nodeId: string
  onNodeChange: (nodeId: string) => void
}) {
  const { t } = useT()
  // State
  const [refFiles, setRefFiles] = useState<readonly ReferenceAudioFile[]>([])
  const [selectedFile, setSelectedFile] = useState('')
  const [waveformSamples, setWaveformSamples] = useState<Float32Array | null>(null)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<AudioTestEnvelope | null>(null)
  const [loading, setLoading] = useState(true)
  const [audioCapabilities, setAudioCapabilities] = useState<{
    activeBackend: string
    availableBackends: readonly {
      id: string
      name: string
      description: string
      available: boolean
      rawLabels?: readonly string[]
    }[]
    sampleRate: number
    chunkDurationMs: number
  } | null>(null)
  const [selectedBackend, setSelectedBackend] = useState<string>('')
  // Per-step settings from the audio-classifier step's `getConfigSchema()`.
  // Initialized to the schema defaults the first time the schema loads.
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [pipelineSchema, setPipelineSchema] = useState<PipelineSchema | null>(null)

  // Load reference audio files from hub (always local — files are a hub resource)
  useEffect(() => {
    trpc.pipelineExecutor.getReferenceAudioFiles
      .query()
      .then(async (files) => {
        setRefFiles(files)
        if (files.length > 0) {
          const first = files[0]!.filename
          setSelectedFile(first)
          await loadAudioFile(first)
        }
      })
      .catch((err: Error) => {
        console.warn('[benchmark:audio] Failed to load audio files:', err)
      })
  }, [trpc])

  // Load audio capabilities from target node (depends on node's backends)
  useEffect(() => {
    trpc.pipelineExecutor.getAudioCapabilities
      .query({ nodeId })
      .then((caps) => {
        setAudioCapabilities(caps)
        if (caps) setSelectedBackend(caps.activeBackend)
        setLoading(false)
      })
      .catch((err: Error) => {
        console.warn('[benchmark:audio] Failed to load audio capabilities:', err)
        setLoading(false)
      })
  }, [trpc, nodeId])

  // Load the pipeline schema so we can render the audio-classifier step's
  // per-step settings (configSchema) — same source of truth as the
  // ObjectDetection step in ImageTab.
  useEffect(() => {
    trpc.pipelineExecutor.getSchema
      .query({ nodeId })
      .then((sch) => {
        setPipelineSchema(sch)
      })
      .catch((err: Error) => {
        console.warn('[benchmark:audio] Failed to load pipeline schema:', err)
      })
  }, [trpc, nodeId])

  // Resolve the audio-classifier addon schema (where the configSchema
  // lives). The slot may host multiple addons in theory; we take the
  // first one — there's currently a single audio-classifier capability.
  const audioClassifierAddon: PipelineAddonSchema | null = useMemo(() => {
    if (!pipelineSchema) return null
    const slot = pipelineSchema.slots.find((s) => s.id === 'audio-classifier')
    if (!slot || slot.addons.length === 0) return null
    return slot.addons[0] ?? null
  }, [pipelineSchema])

  const audioConfigSchema: readonly ConfigField[] = useMemo(
    () => audioClassifierAddon?.configSchema ?? [],
    [audioClassifierAddon],
  )

  // NOTE: the legacy micro/macro class mode + `enabledClasses`
  // multiselect + backend rawLabels list were removed in the Phase 6
  // step rework. The `audio-classifier` step schema now exposes only a
  // single `minScore` slider. `microLabelOptions` + the reset useEffect
  // that watched classMode are gone.

  // Initialize settings from schema defaults the first time it loads.
  useEffect(() => {
    if (audioConfigSchema.length === 0) return
    const initial: Record<string, unknown> = {}
    for (const field of audioConfigSchema) {
      if ('key' in field && 'default' in field && field.default !== undefined) {
        initial[field.key] = field.default
      }
    }
    setSettings((prev) => (Object.keys(prev).length === 0 ? initial : prev))
  }, [audioConfigSchema])

  // Load audio file for waveform display
  const loadAudioFile = useCallback(
    async (filename: string) => {
      try {
        const res = await trpc.pipelineExecutor.getReferenceAudio.query({
          filename,
        })
        if (res?.base64) {
          const samples = decodeWavSamples(res.base64)
          setWaveformSamples(samples)
        }
      } catch (err) {
        console.warn('[benchmark:audio] Failed to load audio:', err)
        setWaveformSamples(null)
      }
    },
    [trpc, nodeId],
  )

  const selectRefFile = async (filename: string) => {
    setSelectedFile(filename)
    setResult(null)
    setError('')
    await loadAudioFile(filename)
  }

  /**
   * P1.3 — the WAV upload is REFUSED, loudly, and it used to be worse than
   * a no-op.
   *
   * `pipelineExecutor.runAudioTest` takes `{addonId, modelId, filename?,
   * settings?}`. There is no field for an uploaded payload, and this handler
   * used to CLEAR `selectedFile` — so the run went out with no filename at
   * all and the provider fell back to the FIRST reference WAV in its
   * directory. The operator uploaded one file and was shown a confident
   * classification of a different one.
   *
   * The button still exists because `ImageSelectorProps.onUpload` is
   * required by the shipped `@camstack/ui-library`; making it optional is a
   * framework change, and this page consumes the HOST's ui-library
   * (`import: false`). So the handler explains itself and changes nothing
   * else: the previously selected reference file stays selected and stays
   * the thing that would run.
   */
  const handleAudioUpload = (b64: string, name: string) => {
    setError(t('audio.uploadUnsupported', { name }))
    // Waveform only — the operator can still LOOK at the file they picked.
    const samples = decodeWavSamples(b64)
    setWaveformSamples(samples)
  }

  // Run audio classification
  const handleClassify = async () => {
    setProcessing(true)
    setError('')
    setResult(null)

    try {
      // Spread into a fresh literal: the generated router input carries a
      // `.loose()` index signature that a named interface does not satisfy.
      const res = await trpc.pipelineExecutor.runAudioTest.mutate({
        ...buildAudioRunInput({
          nodeId,
          addonId: selectedBackend,
          filename: selectedFile,
          settings,
        }),
      })
      console.log('[benchmark:audio] runAudioTest response:', JSON.stringify(res, null, 2))
      setResult(res)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setProcessing(false)
    }
  }

  // ── Inline renderers for the audio-classifier step's configSchema ──
  // Mirrors the chip-style multiselect / select used in ui-library's
  // PipelineStep, but local so AudioTab doesn't need to import private
  // composites. After the Phase 6 step rework the audio-classifier
  // schema only exposes a single `minScore` slider — the legacy
  // `enabledClasses` / `classMode` / `topN` fields + the backend raw
  // label swap logic are gone.
  function setSettingValue(key: string, value: unknown) {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  function renderConfigField(field: ConfigField): React.ReactNode {
    if (field.type === 'slider') {
      const raw = settings[field.key]
      const fallback = typeof field.default === 'number' ? field.default : field.min
      const current = typeof raw === 'number' ? raw : fallback
      return (
        <div key={field.key}>
          <label className="flex items-center justify-between text-[10px] font-medium text-foreground-subtle uppercase tracking-wide mb-1">
            <span>{field.label}</span>
            <span className="font-mono text-foreground">{current.toFixed(2)}</span>
          </label>
          {field.description && (
            <p className="text-[10px] text-foreground-subtle/60 mb-1.5">{field.description}</p>
          )}
          <Slider
            min={field.min}
            max={field.max}
            step={field.step ?? 0.05}
            value={current}
            onChange={(e) => setSettingValue(field.key, Number(e.target.value))}
            className="w-full"
          />
        </div>
      )
    }

    if (field.type === 'number') {
      const raw = settings[field.key]
      const fallback = typeof field.default === 'number' ? field.default : 0
      const current = typeof raw === 'number' ? raw : fallback
      const min = typeof field.min === 'number' ? field.min : 0
      const max = typeof field.max === 'number' ? field.max : 1
      const step = typeof field.step === 'number' ? field.step : 0.05
      return (
        <div key={field.key}>
          <label className="flex items-center justify-between text-[10px] font-medium text-foreground-subtle uppercase tracking-wide mb-1">
            <span>{field.label}</span>
            <span className="font-mono text-foreground">{current.toFixed(2)}</span>
          </label>
          {field.description && (
            <p className="text-[10px] text-foreground-subtle/60 mb-1.5">{field.description}</p>
          )}
          <Slider
            min={min}
            max={max}
            step={step}
            value={current}
            onChange={(e) => setSettingValue(field.key, Number(e.target.value))}
            className="w-full"
          />
        </div>
      )
    }

    if (field.type === 'multiselect') {
      const raw = settings[field.key]
      const current: readonly string[] = Array.isArray(raw)
        ? (raw as string[])
        : Array.isArray(field.default)
          ? (field.default as string[])
          : []
      const toggle = (opt: string) => {
        const next = current.includes(opt) ? current.filter((v) => v !== opt) : [...current, opt]
        setSettingValue(field.key, next)
      }
      return (
        <div key={field.key}>
          <label className="block text-[10px] font-medium text-foreground-subtle uppercase tracking-wide mb-1">
            {field.label}
          </label>
          {field.description && (
            <p className="text-[10px] text-foreground-subtle/60 mb-1.5">{field.description}</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {field.options.map((o) => {
              const selected = current.includes(o.value)
              return (
                <Button
                  variant="unstyled"
                  key={o.value}
                  type="button"
                  onClick={() => toggle(o.value)}
                  className={`text-[10px] font-medium px-2.5 py-2 sm:px-2 sm:py-1 rounded-md border transition-colors ${
                    selected
                      ? 'bg-primary/20 text-primary border-primary/40'
                      : 'bg-surface text-foreground-subtle border-border hover:border-primary/30'
                  }`}
                >
                  {o.label}
                </Button>
              )
            })}
          </div>
        </div>
      )
    }

    if (field.type === 'select') {
      const raw = settings[field.key]
      const current = typeof raw === 'string' ? raw : ((field.default as string | undefined) ?? '')
      return (
        <div key={field.key}>
          <label className="block text-[10px] font-medium text-foreground-subtle uppercase tracking-wide mb-1.5">
            {field.label}
          </label>
          <Select
            value={current}
            onChange={(e) => setSettingValue(field.key, e.target.value)}
            className="w-full"
          >
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      )
    }

    return null
  }

  if (loading) {
    return (
      <div className="text-sm text-foreground-subtle animate-pulse py-8 text-center">
        {t('audio.loading')}
      </div>
    )
  }

  // Derived values from the AudioResult shape. The benchmark UI displays:
  //   - `detections[]`  — one entry per class above `minScore`
  //   - `alternateTopN` — the full ranked list from `debug.alternateLabels`
  //   - `inferenceMs`   — per-step analyzer latency from `debug.stepTimings`
  //   - `totalMs`       — wall-clock from `debug.totalInferenceMs`
  //
  // P1.2 — the two reads above are keyed by `AUDIO_DEBUG_SOURCE`, the key
  // BOTH producers write. This block used to read `audio-classifier`, which
  // no producer writes, so the Classifications panel and the inference
  // timing were permanently empty while looking like a working panel.
  const frame = result?.frame
  const detections = frame?.detections ?? []
  const { alternateTopN, inferenceMs, totalMs } = selectAudioDebug(frame)

  return (
    <div className="space-y-4">
      <SectionToolbar
        testId="benchmark-audio-toolbar"
        className="sm:items-end"
        end={
          <div className="min-w-0 max-w-full overflow-x-auto">
            <NodePicker selectedNodeId={nodeId} onSelect={onNodeChange} hideIcon label="" />
          </div>
        }
      />
      {/* P1.1 — the `audio-analyzer` override form is DELETED, not wired.
          It rendered with `mode='override'` and no `onOverrideChange`, so it
          printed "applies to this run only" and dropped every edit on the
          floor. It cannot be wired here either: `runAudioTest` accepts only
          per-step `settings` (which the Classifier Settings panel below
          already sends), and there is no channel for the analyzer addon's
          global settings without a `*.cap.ts` change. A knob a bench draws
          either reaches the run or is not drawn. */}
      {/* File selector — same component used by ImageTab so the two
          tabs share an identical chip-row + Upload button at the top. */}
      <ImageSelector
        images={refFiles.map((f) => ({
          filename: f.filename,
          sizeKB: f.sizeKb,
        }))}
        selectedFilename={selectedFile}
        onSelect={(filename: string) => {
          void selectRefFile(filename)
        }}
        onUpload={(b64: string, name: string) => handleAudioUpload(b64, name)}
        accept=".wav,audio/wav"
        uploadLabel={t('audio.uploadLabel')}
      />
      <div className="text-[11px] text-foreground-subtle px-1">
        <Trans
          i18nKey="audio.referenceOnly"
          components={{ code: <code className="font-mono" /> }}
        />
      </div>

      {error && (
        <div className="rounded-md bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {/* Main layout — 2 columns (mirrors ImageTab) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* LEFT COLUMN: Waveform + Results */}
        <div className="space-y-3">
          {/* Waveform (analogous to DetectionCanvas) */}
          <div className="rounded-xl border border-border bg-surface overflow-hidden">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between">
              <h3 className="text-xs font-medium text-foreground">{t('audio.waveform')}</h3>
              {detections.length > 0 && (
                <span className="text-[10px] text-foreground-subtle">
                  {t('audio.detections', { count: detections.length })}
                </span>
              )}
            </div>
            <div className="p-2">
              {waveformSamples ? (
                <AudioWaveform samples={waveformSamples} height={140} color="#3b82f6" />
              ) : (
                <div className="h-[140px] flex items-center justify-center text-xs text-foreground-subtle">
                  {t('audio.selectFile')}
                </div>
              )}
            </div>
          </div>

          {/* Best match highlight — the top-1 detection (highest score)
              with its `macroClass` + optional `debug.originalClass`
              annotation when the raw backend label differs. */}
          {result?.success &&
            detections.length > 0 &&
            (() => {
              const best = detections[0]!
              const originalClass = best.debug?.originalClass
              return (
                <div className="rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-medium text-foreground">
                      {t('audio.bestMatch')}
                    </span>
                    <span className="text-sm font-semibold text-primary truncate">
                      {best.macroClass}
                    </span>
                    {originalClass && originalClass !== best.macroClass && (
                      <span className="text-[10px] font-mono text-foreground-subtle truncate">
                        ({originalClass})
                      </span>
                    )}
                    <span className="text-xs font-mono text-foreground-subtle">
                      {(best.score * 100).toFixed(1)}%
                    </span>
                  </div>
                  {inferenceMs != null && (
                    <span className="text-[10px] font-mono text-foreground-subtle">
                      {inferenceMs.toFixed(1)}ms
                    </span>
                  )}
                </div>
              )
            })()}

          {/* Step timings — pulled from `frame.debug.stepTimings` and
              `frame.debug.totalInferenceMs`. The audio-analyzer step
              is the only timed step for the benchmark path today. */}
          {result?.success && totalMs != null && (
            <div className="rounded-xl border border-border bg-surface overflow-hidden">
              <div className="px-3 py-2 border-b border-border">
                <h3 className="text-xs font-medium text-foreground">{t('audio.timings')}</h3>
              </div>
              <div className="px-3 py-2 space-y-1.5">
                {inferenceMs != null && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-foreground-subtle">
                      {t('audio.inference', { backend: selectedBackend })}
                    </span>
                    <span className="font-mono text-foreground">{inferenceMs.toFixed(1)}ms</span>
                  </div>
                )}
                <div className="flex items-center justify-between text-xs">
                  <span className="text-foreground-subtle">{t('audio.total')}</span>
                  <span className="font-mono text-foreground">{totalMs}ms</span>
                </div>
                {inferenceMs != null && totalMs > 0 && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-foreground-subtle">{t('audio.overhead')}</span>
                    <span className="font-mono text-foreground">
                      {(totalMs - inferenceMs).toFixed(1)}ms
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Classification list — the full top-N ranked list from the
              analyzer's `debug.alternateLabels['audio-analyzer']` — see
              `AUDIO_DEBUG_SOURCE`.
              This is the complete ranking regardless of `minScore`; the
              entries that also exceeded the threshold became
              AudioDetection entries and appear highlighted below. */}
          <div className="rounded-xl border border-border bg-surface overflow-hidden">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between">
              <h3 className="text-xs font-medium text-foreground">{t('audio.classifications')}</h3>
              <span className="text-[10px] text-foreground-subtle">
                {t('audio.labels', { count: alternateTopN.length })}
              </span>
            </div>
            <div className="px-3 py-2 max-h-80 overflow-y-auto">
              {processing ? (
                <div className="text-[10px] text-foreground-subtle animate-pulse py-2 text-center">
                  {t('audio.classifying')}
                </div>
              ) : alternateTopN.length > 0 ? (
                <div className="space-y-1">
                  {alternateTopN.slice(0, 50).map((l: ScoredLabel, i: number) => {
                    const passed = detections.some((d) => d.macroClass === l.label)
                    return (
                      <div
                        key={`${l.label}-${i}`}
                        className="flex items-center justify-between text-[11px]"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className={`truncate ${passed ? 'text-primary font-medium' : 'text-foreground'}`}
                          >
                            {l.label}
                          </span>
                          {passed && (
                            <span className="text-[9px] font-mono text-primary/70 uppercase">
                              {t('audio.detected')}
                            </span>
                          )}
                        </div>
                        <span className="font-mono text-foreground-subtle flex-shrink-0 ml-2">
                          {(l.score * 100).toFixed(1)}%
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="text-[10px] text-foreground-subtle py-2 text-center">
                  {t('audio.noClassifications')}
                </div>
              )}
            </div>
          </div>

          {/* Raw response log */}
          <ResponseLog data={result} label={t('audio.response')} />
        </div>

        {/* RIGHT COLUMN: Backend selector + Run button */}
        <div className="space-y-3">
          {/* Backend selector (analogous to PipelineBuilder) */}
          {audioCapabilities && (
            <div className="rounded-xl border border-border bg-surface overflow-hidden">
              <div className="px-3 py-2 border-b border-border">
                <h3 className="text-xs font-medium text-foreground">{t('audio.backend')}</h3>
              </div>
              <div className="p-3 space-y-2">
                {audioCapabilities.availableBackends.map((b) => (
                  <Button
                    variant="unstyled"
                    key={b.id}
                    onClick={() => {
                      setSelectedBackend(b.id)
                      setResult(null)
                    }}
                    className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
                      selectedBackend === b.id
                        ? 'bg-primary/10 border-primary/30 text-foreground'
                        : 'border-border text-foreground-subtle hover:bg-surface-hover'
                    }`}
                  >
                    <div className="text-xs font-medium">{b.name}</div>
                    <div className="text-[10px] text-foreground-subtle">{b.description}</div>
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Settings — rendered from the audio-classifier step's
              configSchema. The unified `enabledClasses` multiselect is
              special-cased in renderConfigField to swap its options
              between macro categories and the active backend's raw
              labels based on `classMode`. */}
          {audioConfigSchema.length > 0 && (
            <div className="rounded-xl border border-border bg-surface overflow-hidden">
              <div className="px-3 py-2 border-b border-border">
                <h3 className="text-xs font-medium text-foreground">{t('audio.settings')}</h3>
              </div>
              <div className="p-3 space-y-3">{audioConfigSchema.map(renderConfigField)}</div>
            </div>
          )}

          {/* Capabilities info */}
          {audioCapabilities && (
            <div className="rounded-xl border border-border bg-surface overflow-hidden">
              <div className="px-3 py-2 border-b border-border">
                <h3 className="text-xs font-medium text-foreground">{t('audio.pipeline')}</h3>
              </div>
              <div className="px-3 py-2 space-y-1">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-foreground-subtle">{t('audio.sampleRate')}</span>
                  <span className="font-mono text-foreground">
                    {audioCapabilities.sampleRate} Hz
                  </span>
                </div>
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-foreground-subtle">{t('audio.chunkDuration')}</span>
                  <span className="font-mono text-foreground">
                    {audioCapabilities.chunkDurationMs}ms
                  </span>
                </div>
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-foreground-subtle">{t('audio.activeBackend')}</span>
                  <span className="font-mono text-foreground">
                    {audioCapabilities.activeBackend}
                  </span>
                </div>
              </div>
            </div>
          )}

          <Button
            variant="unstyled"
            onClick={handleClassify}
            disabled={processing || !selectedFile}
            className={`w-full px-4 py-2.5 text-sm font-medium rounded-lg transition-colors sticky bottom-4 ${
              processing
                ? 'bg-primary text-primary-foreground animate-pulse'
                : 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50'
            }`}
          >
            {processing ? t('audio.classifying') : t('audio.classify')}
          </Button>
        </div>
      </div>
    </div>
  )
}
