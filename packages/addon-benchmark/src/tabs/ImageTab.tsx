import { useState, useEffect, useCallback, useRef } from 'react'
import type { AddonPageProps } from '@camstack/ui-library'
import {
  DetectionCanvas,
  DetectionResultTree,
  StepTimings,
  ImageSelector,
  NodePicker,
  PipelineBuilder,
  ResponseLog,
  SectionToolbar,
  type PipelineStepDisplayConfig,
  type Detection,
} from '@camstack/ui-library'
import type { PipelineSchema, PipelineAddonSchema } from '@camstack/types'
import type { FrameResult } from '@camstack/types'
import { buildPipelineRunInput } from '../bench-payloads.js'
import { resolvedStepsToRunSteps } from '../camera-context.js'
import { type ResolvedTarget, RunTargetPicker } from '../components/RunTargetPicker.js'
import { useT } from '../i18n/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDefaultSteps(schema: PipelineSchema): PipelineStepDisplayConfig[] {
  const detectors = [...(schema.slots.find((s) => s.id === 'detector')?.addons ?? [])]
  const croppers = [...(schema.slots.find((s) => s.id === 'cropper')?.addons ?? [])]
  const classifiers = [...(schema.slots.find((s) => s.id === 'classifier')?.addons ?? [])]
  const refiners = [...(schema.slots.find((s) => s.id === 'refiner')?.addons ?? [])]

  /** Create a step using backend defaults resolved by the server's PlatformScorer */
  function makeStep(addon: PipelineAddonSchema, enabled: boolean): PipelineStepDisplayConfig {
    return {
      addonId: addon.id,
      addonName: addon.name,
      slot: addon.slot,
      inputClasses: [...addon.inputClasses],
      outputClasses: [...addon.outputClasses],
      enabled,
      modelId: addon.defaultModelId,
      children: [] as PipelineStepDisplayConfig[],
      settings: {},
    }
  }

  /** Build recognizer children for a cropper based on class compatibility */
  function buildRecognizers(cropper: PipelineAddonSchema): PipelineStepDisplayConfig[] {
    return classifiers
      .filter((cls) => cls.inputClasses.some((ic) => cropper.outputClasses.includes(ic)))
      .map((cls) => makeStep(cls, false))
  }

  return detectors.map((det) => {
    // Only `object-detection` is enabled by default; other detectors in the slot
    // (e.g. `package-detection`, which is motion-settle-gated and not the common
    // benchmark target) ship DISABLED so a fresh bench measures plain object
    // detection. The operator can still toggle them on.
    const detStep = makeStep(det, det.id === 'object-detection')
    return {
      ...detStep,
      children: [
        // Croppers with recognizer children
        ...croppers
          .filter((c) => c.inputClasses.some((ic) => det.outputClasses.includes(ic)))
          .map((c) => ({
            ...makeStep(c, false),
            children: buildRecognizers(c),
          })),
        // Direct classifiers (not already under a cropper)
        ...classifiers
          .filter((c) => c.inputClasses.some((ic) => det.outputClasses.includes(ic)))
          .filter(
            (c) =>
              !croppers.some(
                (cr) =>
                  cr.inputClasses.some((ic) => det.outputClasses.includes(ic)) &&
                  c.inputClasses.some((ic) => cr.outputClasses.includes(ic)),
              ),
          )
          .map((c) => makeStep(c, false)),
        // Refiners (segmentation post-processing — runs on any detection)
        ...refiners.map((r) => makeStep(r, false)),
      ],
    }
  })
}

/** Minimal shape expected by runPipelineTest — matches PipelineStepInputOutput */
interface ApiStep {
  readonly addonId: string
  readonly modelId: string
  readonly enabled: boolean
  readonly children?: readonly ApiStep[]
  readonly settings?: Record<string, unknown>
}

function convertStepToApi(step: PipelineStepDisplayConfig): ApiStep {
  return {
    addonId: step.addonId,
    modelId: step.modelId,
    enabled: step.enabled,
    children: step.children.map((c) => convertStepToApi(c)),
    ...(step.settings && Object.keys(step.settings).length > 0 ? { settings: step.settings } : {}),
  }
}

// ---------------------------------------------------------------------------
// Image Tester Tab — pipeline builder with always-visible image
// ---------------------------------------------------------------------------

// Reference image shape from the router
interface ReferenceImage {
  readonly filename: string
  readonly stepIds?: readonly string[]
}

interface ImageTabProps {
  readonly trpc: AddonPageProps['trpc']
  readonly nodeId: string
  /**
   * Selecting a camera retargets the page-level node to the one the camera
   * is LIVE on. The node lives above this tab, so the tab asks.
   */
  readonly onNodeChange: (nodeId: string) => void
}

export function ImageTab({ trpc, nodeId, onNodeChange }: ImageTabProps) {
  const { t } = useT()
  const [schema, setSchema] = useState<PipelineSchema | null>(null)
  // Image
  const [refImages, setRefImages] = useState<readonly ReferenceImage[]>([])
  const [selectedRefImage, setSelectedRefImage] = useState('')
  const [uploadedBase64, setUploadedBase64] = useState<string | null>(null)
  const [uploadedName, setUploadedName] = useState('')
  const [displayImageSrc, setDisplayImageSrc] = useState<string | null>(null)
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number }>({
    w: 640,
    h: 480,
  })

  // Pipeline
  const [steps, setSteps] = useState<PipelineStepDisplayConfig[]>([])

  // Run target — the `(camera, node, deviceKey)` triple the pipeline works
  // in. `selectedCameraId === null` is the "custom tree" mode: the free-form
  // step-tree lab this tab used to be, kept because it is how a NEW step
  // gets tried before any camera has it.
  const [selectedCameraId, setSelectedCameraId] = useState<number | null>(null)
  const [deviceKey, setDeviceKey] = useState<string | null>(null)
  const [target, setTarget] = useState<ResolvedTarget | null>(null)

  // Results
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<FrameResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [progressMessages, setProgressMessages] = useState<string[]>([])

  // Current sessionId — set when the user clicks Run, cleared on completion.
  // The persistent subscription filters by this ref so only matching events
  // are delivered to `progressMessages`.
  const sessionIdRef = useRef<string | null>(null)
  // Visibility toggles — detection path keys that are hidden (e.g., "0", "1.2")
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())
  const handleToggleVisibility = useCallback((key: string, visible: boolean) => {
    setHiddenKeys((prev) => {
      const next = new Set(prev)
      if (visible) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // Clear results when nodeId changes
  useEffect(() => {
    setResult(null)
    setError('')
    setProgressMessages([])
  }, [nodeId])

  // Persistent subscription to pipeline.progress — established once on mount
  // so it's already active before the user clicks Run Pipeline. This avoids
  // the race condition where short-lived runs complete before a per-click
  // subscription has finished the WebSocket handshake.
  // NOTE: must NOT use optional chaining on .subscribe() — Vite compiles it
  // into .call() which breaks tRPC Proxy's internal `this` binding.
  useEffect(() => {
    let unsub: (() => void) | null = null
    try {
      const sub = trpc.live.onEvent.subscribe(
        { category: 'pipeline.progress' },
        {
          onData: (event) => {
            const data = (
              typeof event.data === 'object' && event.data !== null ? event.data : event
            ) as Record<string, unknown>
            const sid = sessionIdRef.current
            if (!sid || data['sessionId'] !== sid) return
            if (data['message']) {
              const msg = String(data['message'])
              setProgressMessages((prev) => [...prev, msg])
            }
          },
          onError: (err: unknown) => {
            console.warn('[benchmark:image] Pipeline progress subscription error:', err)
          },
        },
      )
      if (sub) unsub = () => sub.unsubscribe()
    } catch (err) {
      console.warn('[benchmark:image] Pipeline progress subscription not available:', err)
    }
    return () => {
      unsub?.()
    }
  }, [trpc])

  // Load reference images from hub (always local — images are a hub resource)
  useEffect(() => {
    trpc.pipelineExecutor.listReferenceImages
      .query()
      .then(async (imgs) => {
        setRefImages(imgs)
        if (imgs.length > 0) {
          const firstFilename = imgs[0]!.filename
          setSelectedRefImage(firstFilename)
          try {
            const img = await trpc.pipelineExecutor.getReferenceImage.query({
              filename: firstFilename,
            })
            if (img) {
              setUploadedBase64(img.base64)
              setImageWithSize(`data:image/jpeg;base64,${img.base64}`)
            }
          } catch (err) {
            console.warn('[benchmark:image] Failed to load reference image:', err)
          }
        }
      })
      .catch((err) => {
        console.warn('[benchmark:image] Failed to load reference images:', err)
      })
  }, [trpc])

  // Load the node's pipeline schema; the builder starts from its defaults.
  useEffect(() => {
    trpc.pipelineExecutor.getSchema
      .query({ nodeId })
      .then((sch) => {
        setSchema(sch)
        setSteps(buildDefaultSteps(sch))
        setLoading(false)
      })
      .catch((err) => {
        console.error('[benchmark:image] Failed to load pipeline data:', err)
        setLoading(false)
      })
  }, [trpc, nodeId])

  /** Set image source and measure natural dimensions */
  const setImageWithSize = (dataUrl: string) => {
    setDisplayImageSrc(dataUrl)
    const img = new Image()
    img.addEventListener('load', () =>
      setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight }),
    )
    img.src = dataUrl
  }

  const selectRefImage = async (filename: string) => {
    setSelectedRefImage(filename)
    setResult(null)
    try {
      const img = await trpc.pipelineExecutor.getReferenceImage.query({
        filename,
      })
      if (img) {
        setUploadedBase64(img.base64)
        setImageWithSize(`data:image/jpeg;base64,${img.base64}`)
      }
    } catch (err) {
      console.warn('[benchmark:image] Failed to load image:', err)
    }
  }

  /**
   * The tree the run uses.
   *
   * With a camera selected this is `resolvePipeline`'s answer, passed
   * through untouched — the orchestrator is the single owner of "which
   * model runs on this (camera, node, device)", and an absent `modelId`
   * stays absent so the executing node resolves its own format default.
   * With no camera it is the free-form builder tree, which is how a new
   * step gets tried before any camera has it.
   */
  const runSteps = target
    ? resolvedStepsToRunSteps(target.steps)
    : steps.map((s) => convertStepToApi(s))

  // Convert UI steps to API format and run pipeline
  const handleRunPipeline = async () => {
    setProcessing(true)
    setError('')
    setResult(null)
    setProgressMessages([])

    // Correlation id — every `pipeline.progress` event emitted by the
    // server for THIS run carries our sessionId + the target nodeId, so
    // we can filter out concurrent runtime dispatches (live camera
    // frames) that share the same event-bus category.
    const sessionId = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    sessionIdRef.current = sessionId

    try {
      if (!uploadedBase64) {
        setError(t('image.noImage'))
        return
      }
      const res = (await trpc.addons.custom.mutate({
        addonId: 'benchmark',
        action: 'runPipelineTest',
        input: {
          ...buildPipelineRunInput({
            steps: runSteps,
            imageBase64: uploadedBase64,
            nodeId,
            sessionId,
            ...(deviceKey ? { deviceKey } : {}),
          }),
        },
      })) as FrameResult
      console.log('[benchmark] runPipelineTest OUTPUT:', JSON.stringify(res, null, 2))
      setResult(res)
    } catch (err: unknown) {
      console.error('[benchmark] runPipelineTest ERROR:', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      sessionIdRef.current = null
      setProcessing(false)
    }
  }

  if (loading)
    return (
      <div className="text-sm text-foreground-subtle animate-pulse py-8 text-center">
        {t('common.loading')}
      </div>
    )

  // Use natural image dimensions (measured on load) — not result dimensions which may differ
  const imgW = naturalSize.w
  const imgH = naturalSize.h

  const allDetections: Detection[] = result?.detections ? [...result.detections] : []

  // Filter out hidden detections for the canvas. The new data model
  // flattens details (face / plate) at the root of `detections[]` with
  // `parentId` — hiding a parent also hides its children by filtering
  // them out here. `hiddenKeys` stores detection ids directly.
  const hiddenParents = new Set<string>()
  for (const d of allDetections) {
    if (d.kind === 'first-level' && hiddenKeys.has(d.id)) hiddenParents.add(d.id)
  }
  const canvasDetections = allDetections.filter((d) => {
    if (hiddenKeys.has(d.id)) return false
    if (d.kind === 'detail' && d.parentId && hiddenParents.has(d.parentId)) return false
    return true
  })

  const timingsRecord: Record<string, number> = {}
  const stepTimings = result?.debug?.stepTimings ?? []
  for (const st of stepTimings) {
    timingsRecord[`${st.source}${st.modelId ? ` (${st.modelId})` : ''}`] = st.ms
  }

  return (
    <div className="space-y-4">
      <SectionToolbar
        testId="benchmark-image-toolbar"
        className="sm:items-end"
        end={
          <div className="min-w-0 max-w-full overflow-x-auto">
            <NodePicker selectedNodeId={nodeId} onSelect={onNodeChange} hideIcon label="" />
          </div>
        }
      />
      {/* P1.1 — the `detection-pipeline` override form is DELETED, not
          wired. It rendered with `mode='override'` and no
          `onOverrideChange`, so it printed "Benchmark override — applies to
          this run only" and dropped every edit on the floor.

          It cannot be wired here either, and that was checked rather than
          assumed: `detection-pipeline`'s global settings are
          `activeModelSubstitutions`, `batchMode` and `windowMs`, and
          `pipelineExecutor.runPipeline` has no field for any of them —
          `engine`, `plane`, `deviceKey`, `steps` and the image sources are
          the whole surface. Wiring it needs a `*.cap.ts` change, so the
          honest Phase-1 move is to stop drawing it. What replaces it is the
          knob set that DOES reach the run. */}
      <RunTargetPicker
        trpc={trpc}
        nodeId={nodeId}
        onNodeChange={onNodeChange}
        deviceKey={deviceKey}
        onDeviceKeyChange={setDeviceKey}
        selectedDeviceId={selectedCameraId}
        onSelectCamera={setSelectedCameraId}
        onResolved={setTarget}
        disabled={processing}
      />

      {/* Image selector — full width */}
      <ImageSelector
        images={refImages}
        selectedFilename={selectedRefImage}
        uploadedName={uploadedName}
        onSelect={selectRefImage}
        onUpload={(b64: string, name: string, dataUrl: string) => {
          setUploadedBase64(b64)
          setUploadedName(name)
          setSelectedRefImage('')
          setImageWithSize(dataUrl)
          setResult(null)
        }}
      />

      {error && (
        <div className="rounded-md bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {/* Main layout — 2 columns on md+, stack on small */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* LEFT COLUMN: Controls + Image + Results */}
        <div className="space-y-2">
          {/* Run pipeline + Benchmark controls — left column header */}
          <button
            onClick={handleRunPipeline}
            disabled={!processing && !selectedRefImage && !uploadedBase64}
            className={`w-full px-4 py-2.5 text-sm font-medium rounded-lg transition-colors ${
              processing
                ? 'bg-primary text-primary-foreground animate-pulse'
                : 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50'
            }`}
          >
            {processing
              ? progressMessages.length > 0
                ? progressMessages[progressMessages.length - 1]
                : t('image.processing')
              : t('image.run')}
          </button>

          <div className="text-[10px] text-foreground-subtle font-mono">
            {t('image.target')}: {nodeId} · {deviceKey ?? t('image.nodeDefaultPool')}
            {target
              ? ` · ${t('image.cameraResolved', { id: target.deviceId })}`
              : ` · ${t('image.customTree')}`}
          </div>

          {/* Detection canvas */}
          <DetectionCanvas
            src={displayImageSrc}
            imageWidth={imgW}
            imageHeight={imgH}
            detections={canvasDetections}
            placeholder={t('image.selectImage')}
          />

          {result && canvasDetections.length > 0 && (
            <div className="text-xs text-foreground-subtle">
              {t('image.detections', { count: canvasDetections.length, w: imgW, h: imgH })}
            </div>
          )}

          {/* Pipeline progress — below image */}
          {progressMessages.length > 0 && (
            <div className="rounded-md border border-border bg-surface p-3 space-y-1 text-xs text-foreground-subtle">
              {progressMessages.map((msg, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 rounded-full shrink-0 ${i === progressMessages.length - 1 ? 'bg-primary animate-pulse' : 'bg-foreground-subtle/30'}`}
                  />
                  {msg}
                </div>
              ))}
            </div>
          )}

          {/* Step timings — below image */}
          {Object.keys(timingsRecord).length > 0 && (
            <StepTimings timings={timingsRecord} totalMs={result?.debug?.totalInferenceMs} />
          )}

          {/* Detection result tree — below timings */}
          {result && (
            <DetectionResultTree
              detections={allDetections}
              hiddenKeys={hiddenKeys}
              onToggleVisibility={handleToggleVisibility}
            />
          )}

          {/* Raw response log */}
          <ResponseLog data={result} label={t('image.response')} />
        </div>

        {/* RIGHT COLUMN: Pipeline builder only */}
        <div className="space-y-2">
          {schema && (
            <PipelineBuilder
              schema={schema}
              steps={steps}
              onChange={(newSteps: readonly PipelineStepDisplayConfig[]) => setSteps([...newSteps])}
              excludeAddons={['audio-classifier']}
            />
          )}
        </div>
      </div>
    </div>
  )
}
