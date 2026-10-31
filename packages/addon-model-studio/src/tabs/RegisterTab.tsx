/**
 * Custom — upload or remote URL.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AddonPageProps } from '@camstack/ui-library'
import type { ModelFormat } from '@camstack/types'
import { registerCustomModel, uploadModelFile, type UploadedModelFile } from '../ui/api.js'
import { summarizeConversionOutcomes } from '../ensure-formats.js'
import { parsePlusCatalogLabelmap } from '../plus-catalog/plus-catalog-import.js'
import {
  buildRegistrationDescriptor,
  REGISTRABLE_POSTPROCESSORS,
  registrablePostprocessor,
  type RegistrationSource,
} from '../plus-catalog/registration.js'
import { Field, NumberField, TextField } from '../components/Form.js'
import { StepSelect } from '../components/StepSelect.js'
import { probeCustomModel } from '../ui/probe-custom-model.js'
import { useOperationModal } from '../components/OperationModalProvider.js'
import {
  DisplayNameField,
  importNameOf,
  isDisplayNameInvalid,
} from '../components/DisplayNameField.js'
import type { UploadPrefill } from './PlusCatalogSourceSections.js'
import { Trans, useT } from '../i18n/index.js'
import { Button, FileInput, Textarea, Select } from '@camstack/ui-library'

interface CustomTabProps {
  readonly trpc: AddonPageProps['trpc']
  readonly onRegistered: (message?: string) => void
  readonly initialPrefill?: UploadPrefill | null
  readonly onPrefillConsumed?: () => void
}

const CUSTOM_FORMATS: readonly ModelFormat[] = ['onnx', 'openvino', 'coreml', 'tflite', 'pt']

const UPLOAD_EXTENSIONS: readonly string[] = ['.onnx', '.tflite', '.pt']

type UploadPhase =
  | { readonly state: 'idle' }
  | { readonly state: 'uploading'; readonly pct: number }
  | { readonly state: 'done'; readonly file: UploadedModelFile }
  | { readonly state: 'error'; readonly message: string }

type SourceKind = 'upload' | 'url'

const SOURCE_OPTIONS: readonly { readonly value: SourceKind }[] = [
  { value: 'upload' },
  { value: 'url' },
]

/** @deprecated Prefer CustomTab — kept as alias for existing imports. */
export type RegisterTabProps = CustomTabProps

export function CustomTab({
  trpc,
  onRegistered,
  initialPrefill = null,
  onPrefillConsumed,
}: CustomTabProps) {
  const { t } = useT()
  const operations = useOperationModal()
  const [sourceKind, setSourceKind] = useState<SourceKind>('upload')
  const [modelId, setModelId] = useState('')
  const [name, setName] = useState('')
  const [stepId, setStepId] = useState('object-detection')
  const [format, setFormat] = useState<ModelFormat>('onnx')
  const [postprocessor, setPostprocessor] = useState<string>('')
  const [url, setUrl] = useState('')
  const [urlSizeMB, setUrlSizeMB] = useState(0)
  const [width, setWidth] = useState(320)
  const [height, setHeight] = useState(320)
  const [labelsText, setLabelsText] = useState('')
  const [prefilledFrom, setPrefilledFrom] = useState<string | null>(null)
  const [probeHints, setProbeHints] = useState<readonly string[]>([])
  const [upload, setUpload] = useState<UploadPhase>({ state: 'idle' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const labels = useMemo(() => parsePlusCatalogLabelmap(labelsText), [labelsText])

  // plus catalog non-redistributable → Custom with metadata prefilled.
  useEffect(() => {
    if (initialPrefill === null || initialPrefill === undefined) return
    setSourceKind('upload')
    setFormat(initialPrefill.format)
    setPostprocessor(initialPrefill.postprocessor ?? '')
    setWidth(initialPrefill.inputSize)
    setHeight(initialPrefill.inputSize)
    setLabelsText(initialPrefill.labels.join('\n'))
    setPrefilledFrom(initialPrefill.sourceLabel)
    setError(null)
    setSuccess(null)
    onPrefillConsumed?.()
  }, [initialPrefill, onPrefillConsumed])

  const applyProbe = useCallback(
    (input: Parameters<typeof probeCustomModel>[0], opts?: { readonly forceId?: boolean }) => {
      const probed = probeCustomModel(input)
      setProbeHints(probed.hints)
      if (probed.format !== null) setFormat(probed.format)
      setWidth(probed.inputSize)
      setHeight(probed.inputSize)
      if (opts?.forceId || !modelId) setModelId(probed.modelId)
      if (!name) setName(probed.name)
      if (probed.sizeMB !== null && input.kind === 'url') setUrlSizeMB(probed.sizeMB)
    },
    [modelId, name],
  )

  const handleFile = useCallback(
    async (file: File) => {
      setError(null)
      applyProbe({ kind: 'file', filename: file.name, bytes: file.size }, { forceId: !modelId })
      setUpload({ state: 'uploading', pct: 0 })
      try {
        const uploaded = await uploadModelFile(trpc, file, (done, total) => {
          setUpload({ state: 'uploading', pct: Math.round((done / total) * 100) })
        })
        setUpload({ state: 'done', file: uploaded })
      } catch (err) {
        setUpload({
          state: 'error',
          message: err instanceof Error ? err.message : t('register.uploadFailed'),
        })
      }
    },
    [trpc, modelId, applyProbe, t],
  )

  const handleProbeUrl = useCallback(() => {
    if (!url.trim()) {
      setError(t('register.enterUrl'))
      return
    }
    setError(null)
    applyProbe({ kind: 'url', url: url.trim() }, { forceId: !modelId })
  }, [url, modelId, applyProbe, t])

  const handleRegister = useCallback(async () => {
    setError(null)
    setSuccess(null)
    const source: RegistrationSource | null =
      sourceKind === 'upload'
        ? upload.state === 'done'
          ? {
              kind: 'upload',
              filename: upload.file.filename,
              sizeMB: Number((upload.file.bytes / 1e6).toFixed(1)),
            }
          : null
        : url.trim()
          ? { kind: 'url', url: url.trim(), sizeMB: urlSizeMB }
          : null
    if (source === null) {
      return setError(
        sourceKind === 'upload' ? t('register.uploadFirst') : t('register.urlRequired'),
      )
    }
    if (isDisplayNameInvalid(name)) return setError(t('register.nameInvalid'))
    setSubmitting(true)
    try {
      const chosenPostprocessor = registrablePostprocessor(postprocessor)
      const descriptor = buildRegistrationDescriptor({
        type: 'custom',
        modelId: modelId.trim(),
        name: importNameOf(name) ?? modelId.trim(),
        stepId,
        source,
        format,
        ...(chosenPostprocessor !== undefined ? { postprocessor: chosenPostprocessor } : {}),
        inputWidth: width,
        inputHeight: height,
        labels,
      })
      await operations.run(
        {
          kind: 'import',
          title: t('register.opTitle', { name: descriptor.entry.name, format }),
          modelId: descriptor.entry.id,
          format,
          steps: [
            { id: 'register', label: t('register.opStepRegister'), status: 'active' },
            { id: 'land', label: t('register.opStepLand'), status: 'pending' },
          ],
          initialLog: t('register.opInitialLog', { name: descriptor.entry.name }),
        },
        async ({ appendLog, patchSteps }) => {
          const result = await registerCustomModel(trpc, descriptor)
          patchSteps((prev) =>
            prev.map((s) =>
              s.status === 'active' || s.status === 'pending' ? { ...s, status: 'done' } : s,
            ),
          )
          appendLog(
            t('register.opDone', {
              stepId,
              summary: summarizeConversionOutcomes(result.conversions),
            }),
          )
        },
      )
      const message = t('register.registered', { name: descriptor.entry.name })
      setSuccess(message)
      onRegistered(message)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('register.failed'))
    } finally {
      setSubmitting(false)
    }
  }, [
    trpc,
    sourceKind,
    modelId,
    name,
    stepId,
    format,
    postprocessor,
    url,
    urlSizeMB,
    width,
    height,
    labels,
    upload,
    onRegistered,
    operations,
    t,
  ])

  return (
    <div className="max-w-2xl space-y-4" data-testid="custom-tab">
      {error && (
        <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
          {success}
        </div>
      )}

      <div className="space-y-1">
        <span className="block text-[10px] font-medium text-foreground-subtle uppercase tracking-wide">
          {t('common.source')}
        </span>
        <div className="inline-flex rounded-md border border-border overflow-hidden">
          {SOURCE_OPTIONS.map((o) => (
            <Button
              variant="unstyled"
              key={o.value}
              type="button"
              onClick={() => {
                setError(null)
                setSuccess(null)
                setSourceKind(o.value)
              }}
              className={[
                'px-3 py-1.5 text-xs transition-colors',
                sourceKind === o.value
                  ? 'bg-primary text-primary-foreground font-medium'
                  : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
              ].join(' ')}
            >
              {t(`register.sources.${o.value}`)}
            </Button>
          ))}
        </div>
      </div>

      {prefilledFrom !== null && sourceKind === 'upload' && (
        <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-[11px] text-foreground-subtle">
          <Trans
            i18nKey="register.prefilled"
            values={{ source: prefilledFrom }}
            components={{ b: <span className="text-foreground" /> }}
          />
        </div>
      )}

      {sourceKind === 'upload' ? (
        <Field label={t('register.modelFile', { extensions: UPLOAD_EXTENSIONS.join(' / ') })}>
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              variant="unstyled"
              onClick={() => fileInputRef.current?.click()}
              disabled={upload.state === 'uploading'}
              className="px-4 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {upload.state === 'uploading'
                ? t('register.uploading', { pct: upload.pct })
                : t('register.chooseFile')}
            </Button>
            {upload.state === 'done' && (
              <span className="text-[11px] text-success font-mono">
                {upload.file.filename} · {(upload.file.bytes / 1e6).toFixed(1)} MB ·{' '}
                {upload.file.sha256.slice(0, 12)}…
              </span>
            )}
            {upload.state === 'error' && (
              <span className="text-[11px] text-danger">{upload.message}</span>
            )}
          </div>
          <FileInput
            ref={fileInputRef}
            accept={UPLOAD_EXTENSIONS.join(',')}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleFile(file)
              e.target.value = ''
            }}
          />
          {upload.state === 'uploading' && (
            <div className="h-1.5 w-full rounded-full bg-surface overflow-hidden mt-2">
              <div
                className="h-full rounded-full bg-primary transition-all duration-200"
                style={{ width: `${Math.max(2, upload.pct)}%` }}
              />
            </div>
          )}
        </Field>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <TextField
                label={t('register.urlLabel')}
                value={url}
                onChange={setUrl}
                placeholder={t('register.urlPlaceholder')}
              />
            </div>
            <NumberField
              label={t('register.sizeMb')}
              value={urlSizeMB}
              onChange={setUrlSizeMB}
              min={0}
            />
          </div>
          <Button
            variant="unstyled"
            type="button"
            onClick={handleProbeUrl}
            className="px-3 py-1.5 text-[10px] font-medium rounded-md border border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover"
          >
            {t('register.probeUrl')}
          </Button>
        </div>
      )}

      {probeHints.length > 0 && (
        <ul className="rounded-md border border-border bg-surface px-3 py-2 text-[10px] text-foreground-subtle space-y-0.5 list-disc list-inside">
          {probeHints.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField
          label={t('common.modelId')}
          value={modelId}
          onChange={setModelId}
          placeholder="my-detector"
        />
        <DisplayNameField
          value={name}
          onChange={setName}
          defaultName={modelId.trim() || t('register.defaultName')}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StepSelect trpc={trpc} value={stepId} onChange={setStepId} />
        <NumberField label={t('register.inputWidth')} value={width} onChange={setWidth} min={1} />
        <NumberField
          label={t('register.inputHeight')}
          value={height}
          onChange={setHeight}
          min={1}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label={t('common.format')}>
          <Select
            value={format}
            onChange={(e) => {
              const next = CUSTOM_FORMATS.find((f) => f === e.target.value)
              if (next !== undefined) setFormat(next)
            }}
            className="w-full"
          >
            {CUSTOM_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('register.decode')}>
          <Select
            value={postprocessor}
            onChange={(e) => setPostprocessor(e.target.value)}
            className="w-full"
          >
            <option value="">{t('register.stepDefault')}</option>
            {REGISTRABLE_POSTPROCESSORS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
          <span className="block text-[10px] text-foreground-subtle pt-1">
            {t('register.decodeWarning')}
          </span>
        </Field>
      </div>

      <Field label={t('register.labelmap', { count: labels.length })}>
        <Textarea
          value={labelsText}
          onChange={(e) => setLabelsText(e.target.value)}
          rows={8}
          spellCheck={false}
          className="w-full px-3 py-1.5 text-xs font-mono rounded-md border border-border bg-surface text-foreground focus:outline-none focus:border-primary/50"
        />
      </Field>

      <div className="flex items-center gap-2">
        <Button
          variant="unstyled"
          onClick={() => void handleRegister()}
          disabled={submitting || (sourceKind === 'upload' && upload.state !== 'done')}
          className="px-4 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {submitting ? t('register.registering') : t('register.registerModel')}
        </Button>
      </div>
    </div>
  )
}

/** Alias for callers / tests that still import RegisterTab. */
export const RegisterTab = CustomTab
