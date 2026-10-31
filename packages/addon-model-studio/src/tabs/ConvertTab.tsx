import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AddonPageProps } from '@camstack/ui-library'
import type { LabelDefinition, ModelConvertMetadata, ModelOutputFormat } from '@camstack/types'
import {
  convertModel,
  recommendConvertNode,
  subscribeConvertProgress,
  type ConvertModelResult,
  type LiveSubscription,
  type NodeRecommendationView,
} from '../ui/api.js'
import {
  buildConvertTargets,
  EMPTY_TARGET_SELECTION,
  formatMB,
  hasAnyTarget,
  type ConvertProgressView,
  type ConvertState,
  type TargetSelection,
} from '../ui/model-studio-ui.js'
import { CheckboxField, Field, TextField } from '../components/Form.js'
import {
  DisplayNameField,
  importNameOf,
  isDisplayNameInvalid,
} from '../components/DisplayNameField.js'
import { useT } from '../i18n/index.js'
import { Button, Select } from '@camstack/ui-library'

interface ConvertTabProps {
  readonly trpc: AddonPageProps['trpc']
  readonly onConverted: () => void
}

const OUTPUT_FORMATS: readonly ModelOutputFormat[] = [
  'yolo',
  'ssd',
  'embedding',
  'classification',
  'ocr',
  'segmentation',
]

function parseLabels(raw: string): readonly LabelDefinition[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((name, index) => ({ id: String(index), name }))
}

export function ConvertTab({ trpc, onConverted }: ConvertTabProps) {
  const { t } = useT()
  // Source + metadata
  const [sourceUrl, setSourceUrl] = useState('')
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [inputSize, setInputSize] = useState<320 | 640>(320)
  const [outputFormat, setOutputFormat] = useState<ModelOutputFormat>('yolo')
  const [labels, setLabels] = useState('')

  // Targets — node is always Auto (orchestrator picks from recommendations).
  const [targets, setTargets] = useState<TargetSelection>(EMPTY_TARGET_SELECTION)
  const [recommendations, setRecommendations] = useState<readonly NodeRecommendationView[]>([])
  const [recommendationsError, setRecommendationsError] = useState<string | null>(null)

  // Run state
  const [state, setState] = useState<ConvertState>('idle')
  const [progress, setProgress] = useState<ConvertProgressView | null>(null)
  const [outcome, setOutcome] = useState<ConvertModelResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const subRef = useRef<LiveSubscription | null>(null)

  useEffect(() => {
    return () => {
      subRef.current?.unsubscribe()
      subRef.current = null
    }
  }, [])

  const convertTargets = useMemo(() => buildConvertTargets(targets), [targets])
  const canRecommend = hasAnyTarget(targets)

  const refreshRecommendations = useCallback(async () => {
    if (!hasAnyTarget(targets)) {
      setRecommendations([])
      return
    }
    try {
      const recs = await recommendConvertNode(trpc, buildConvertTargets(targets))
      setRecommendations(recs)
      setRecommendationsError(null)
    } catch (err) {
      // Surfaced, not swallowed: an empty recommendation strip with no reason
      // reads as "no capable nodes" when the query merely failed.
      setRecommendations([])
      setRecommendationsError(err instanceof Error ? err.message : t('convert.recommendFailed'))
    }
  }, [trpc, targets, t])

  useEffect(() => {
    void refreshRecommendations()
  }, [refreshRecommendations])

  const handleConvert = useCallback(async () => {
    setError(null)
    setOutcome(null)
    if (!sourceUrl.trim()) return setError(t('convert.sourceRequired'))
    if (!id.trim()) return setError(t('convert.idRequired'))
    if (!/^[a-zA-Z0-9._-]+$/.test(id.trim())) return setError(t('convert.idInvalid'))
    if (isDisplayNameInvalid(name)) return setError(t('register.nameInvalid'))
    if (convertTargets.length === 0) return setError(t('convert.targetRequired'))

    const metadata: ModelConvertMetadata = {
      id: id.trim(),
      name: importNameOf(name) ?? id.trim(),
      labels: parseLabels(labels),
      inputSize: { width: inputSize, height: inputSize },
      outputFormat,
    }
    setState('running')
    setProgress({ phase: 'starting' })

    // Subscribe to live `model-convert.progress` events before kicking off the
    // long-running mutation (mirrors the benchmark Pipeline tab pattern). The
    // orchestrator's `convertModel` action does not thread a session id, so the
    // events carry none — show whatever progress the active conversion emits.
    subRef.current?.unsubscribe()
    subRef.current = subscribeConvertProgress(
      trpc,
      (event) => {
        setProgress({ phase: event.phase, pct: event.pct, detail: event.detail })
      },
      (err) => {
        console.warn('[model-studio:convert] progress subscription error:', err)
      },
    )

    try {
      // Node is always Auto: the orchestrator picks a capable host from
      // recommendConvertNode. Manual NodeSelector was removed so the UI cannot
      // pin a node that the recommendations strip already marked unsupported.
      const result = await convertModel(trpc, {
        sourceUrl: sourceUrl.trim(),
        metadata,
        targets: convertTargets,
      })
      setOutcome(result)
      setState('success')
      onConverted()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('convert.failed'))
      setState('error')
    } finally {
      subRef.current?.unsubscribe()
      subRef.current = null
    }
  }, [trpc, sourceUrl, id, name, labels, inputSize, outputFormat, convertTargets, onConverted, t])

  const running = state === 'running'

  return (
    <div className="max-w-2xl space-y-4">
      <div className="rounded-md border border-border bg-surface px-3 py-2 text-[11px] text-foreground-subtle">
        {t('convert.intro')}
      </div>

      {error && (
        <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {/* Source */}
      <TextField
        label={t('convert.sourceUrl')}
        value={sourceUrl}
        onChange={setSourceUrl}
        placeholder="https://…/model.onnx"
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField
          label={t('common.modelId')}
          value={id}
          onChange={setId}
          placeholder="my-yolo-v9"
        />
        <DisplayNameField
          value={name}
          onChange={setName}
          defaultName={id.trim() || t('convert.defaultName')}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('convert.inputSize')}>
          <Select
            aria-label={t('convert.inputSize')}
            value={inputSize}
            onChange={(e) => setInputSize(e.target.value === '320' ? 320 : 640)}
            className="w-full"
          >
            <option value={320}>320 × 320</option>
            <option value={640}>640 × 640</option>
          </Select>
        </Field>
        <Field label={t('convert.outputFormat')}>
          <Select
            value={outputFormat}
            onChange={(e) => {
              const next = OUTPUT_FORMATS.find((f) => f === e.target.value)
              if (next !== undefined) setOutputFormat(next)
            }}
            className="w-full"
          >
            {OUTPUT_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <TextField
        label={t('convert.labels')}
        value={labels}
        onChange={setLabels}
        placeholder={t('convert.labelsPlaceholder')}
      />

      {/* Targets */}
      <Field label={t('convert.targetFormats')}>
        <div className="flex flex-wrap gap-4 pt-1">
          <CheckboxField
            label="OpenVINO fp16"
            checked={targets.openvinoFp16}
            onChange={(v) => setTargets((prev) => ({ ...prev, openvinoFp16: v }))}
          />
          <CheckboxField
            label="OpenVINO int8"
            checked={targets.openvinoInt8}
            onChange={(v) => setTargets((prev) => ({ ...prev, openvinoInt8: v }))}
          />
          <CheckboxField
            label="CoreML"
            checked={targets.coreml}
            onChange={(v) => setTargets((prev) => ({ ...prev, coreml: v }))}
          />
        </div>
      </Field>

      {/* Auto node — recommendations only; no manual NodeSelector */}
      <Field label={t('convert.targetNode')}>
        <p className="text-[11px] text-foreground-subtle pt-0.5">{t('convert.auto')}</p>
      </Field>

      {canRecommend && recommendationsError && (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[10px] text-warning">
          {t('convert.recsUnavailable', { error: recommendationsError })}
        </div>
      )}

      {canRecommend && recommendations.length > 0 && (
        <div className="rounded-md border border-border bg-surface px-3 py-2 space-y-1">
          <span className="text-[10px] text-foreground-subtle uppercase tracking-wide">
            {t('convert.recs')}
          </span>
          <div className="flex flex-wrap gap-2">
            {recommendations.map((r) => (
              <span
                key={r.nodeId}
                className={`px-2 py-1 rounded-md text-[10px] ${
                  r.supported
                    ? 'bg-success/15 text-success'
                    : 'bg-surface-hover text-foreground-subtle'
                }`}
                title={r.reason}
              >
                {r.supported ? '✓ ' : '✕ '}
                {r.nodeId} · {r.reason}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button
          variant="unstyled"
          onClick={() => void handleConvert()}
          disabled={running}
          className="px-4 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {running ? t('convert.converting') : t('convert.convert')}
        </Button>
        {canRecommend && (
          <Button
            variant="unstyled"
            onClick={() => void refreshRecommendations()}
            disabled={running}
            className="px-3 py-1.5 text-[10px] font-medium rounded-md border border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
          >
            {t('convert.refreshRecs')}
          </Button>
        )}
      </div>

      <ProgressPanel state={state} progress={progress} outcome={outcome} />
    </div>
  )
}

function ProgressPanel({
  state,
  progress,
  outcome,
}: {
  state: ConvertState
  progress: ConvertProgressView | null
  outcome: ConvertModelResult | null
}) {
  const { t } = useT()
  if (state === 'idle') return null

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-3 py-2 border-b border-border flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${
            state === 'running'
              ? 'bg-warning animate-pulse'
              : state === 'success'
                ? 'bg-success'
                : 'bg-danger'
          }`}
        />
        <h3 className="text-xs font-medium text-foreground">
          {state === 'running'
            ? t('convert.inProgress')
            : state === 'success'
              ? t('convert.complete')
              : t('convert.failed')}
        </h3>
      </div>

      <div className="px-3 py-3 space-y-3">
        {progress && state === 'running' && (
          <>
            <div className="flex items-center justify-between text-xs">
              <span className="font-mono text-foreground">{progress.phase}</span>
              {progress.pct !== undefined && (
                <span className="font-mono text-foreground-subtle">{progress.pct.toFixed(0)}%</span>
              )}
            </div>
            <div className="h-2 w-full rounded-full bg-surface overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${Math.max(4, Math.min(100, progress.pct ?? 8))}%` }}
              />
            </div>
            {progress.detail && (
              <div className="text-[10px] text-foreground-subtle truncate">{progress.detail}</div>
            )}
          </>
        )}

        {state === 'success' && outcome && (
          <div className="space-y-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-foreground-subtle">{t('convert.registeredAs')}</span>
              <span className="font-mono text-foreground">{outcome.entry.id}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-foreground-subtle">{t('convert.onNode')}</span>
              <span className="font-mono text-foreground">{outcome.nodeId}</span>
            </div>
            <div className="space-y-1">
              <span className="text-[10px] text-foreground-subtle uppercase tracking-wide">
                {t('convert.artifacts')}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {outcome.artifacts.map((a, i) => (
                  <span
                    key={`${a.format}-${a.precision ?? 'na'}-${i}`}
                    className={`px-2 py-1 rounded-md text-[10px] ${
                      a.validated ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
                    }`}
                  >
                    {a.format}
                    {a.precision ? ` ${a.precision}` : ''} · {formatMB(a.sizeMB)}
                    {a.validated ? '' : t('convert.unvalidated')}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
