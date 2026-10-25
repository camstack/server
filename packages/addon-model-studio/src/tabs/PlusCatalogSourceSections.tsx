/**
 * The plus catalog source of the unified Register flow (D214 addendum).
 *
 * With a configured plus catalog API key it shows EXACTLY what the account has
 * access to — the real `GET /v1/model/list` (base + custom models, the same
 * split plus catalog's own settings UI renders on `isBaseModel`) — and imports
 * server-side via the presigned `signed_url`. Nothing is invented: engine
 * compatibility (`supportedDetectors`) and input dimensions come from each
 * entry's own metadata.
 *
 * Without a key, the honest fallback: the publicly downloadable plus catalog
 * default (SSDLite MobileDet EdgeTPU) plus an inline plus catalog API key form
 * — saved through the SAME addon setting (one authority, D62).
 */
import { useCallback, useEffect, useState } from 'react'
import type { AddonPageProps } from '@camstack/ui-library'
import type { ModelFormat, PostprocessorType } from '@camstack/types'
import {
  plusCatalogPlusListModels,
  plusCatalogPlusStatus,
  plusCatalogPlusTest,
  importPlusCatalogCatalogModel,
  savePlusCatalogApiKey,
  type PlusCatalogModelView,
  type PlusCatalogStatusView,
} from '../ui/api.js'
import { ImportProgressModal, type ImportProgressStep } from '../components/ImportProgressModal.js'
import {
  appendOperationLog,
  finishOperationSession,
  startOperationSession,
} from '../ui/operation-sessions.js'
import { PLUS_CATALOG_PUBLIC_CATALOG } from '../plus-catalog/plus-catalog-catalog.js'
import { isValidPlusApiKey } from '../plus-catalog/plus-catalog-api.js'
import { Field } from '../components/Form.js'
import { REGISTER_SELECT_CLASS } from '../components/register-shared.js'
import { TfliteGateNote, useTfliteNodes } from '../components/TfliteGate.js'
import {
  DisplayNameField,
  importNameOf,
  isDisplayNameInvalid,
} from '../components/DisplayNameField.js'
import { PlusCatalogBrowser } from './PlusCatalogBrowser.js'
import { Trans, useT } from '../i18n/index.js'

type Trpc = AddonPageProps['trpc']

const PLUS_DOCS_URL = 'https://docs.frigate.video/integrations/plus/'

/** Characteristics handed to the Upload form (fallback utility). */
export interface UploadPrefill {
  readonly sourceLabel: string
  readonly format: ModelFormat
  readonly postprocessor?: PostprocessorType
  readonly inputSize: number
  readonly labels: readonly string[]
}

export interface PlusCatalogSectionProps {
  readonly trpc: Trpc
  readonly onRegistered: (message: string) => void
  readonly onError: (message: string) => void
  readonly onPrefillUpload: (prefill: UploadPrefill) => void
  /** Catalog NodeSelector — preferred land target when set. */
  readonly landNodeId?: string
}

/**
 * Write-only plus catalog API key form (Catalog → plus catalog). The stored value is
 * never fetched or shown — only configured / not.
 */
function PlusCatalogKeyPanel({
  trpc,
  status,
  onStatusChange,
}: {
  readonly trpc: Trpc
  readonly status: PlusCatalogStatusView
  readonly onStatusChange: (next: PlusCatalogStatusView) => void
}) {
  const [keyDraft, setKeyDraft] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [keySaving, setKeySaving] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [replacingKey, setReplacingKey] = useState(false)
  const { t } = useT()

  const handleTest = useCallback(async () => {
    setBusy(true)
    setTestResult(null)
    try {
      const result = await plusCatalogPlusTest(trpc)
      setTestResult(
        result.ok
          ? t('plusCatalog.connectionOk')
          : (result.error ?? t('plusCatalog.connectionFailed')),
      )
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : t('plusCatalog.connectionFailed'))
    } finally {
      setBusy(false)
    }
  }, [trpc, t])

  const handleSaveKey = useCallback(async () => {
    const draft = keyDraft.trim()
    setKeyError(null)
    if (!isValidPlusApiKey(draft)) {
      setKeyError(t('plusCatalog.keyFormatInvalid'))
      return
    }
    setKeySaving(true)
    try {
      await savePlusCatalogApiKey(trpc, draft)
      setKeyDraft('')
      setReplacingKey(false)
      const next = await plusCatalogPlusStatus(trpc)
      onStatusChange(next)
      await handleTest()
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : t('plusCatalog.keySaveFailed'))
    } finally {
      setKeySaving(false)
    }
  }, [trpc, keyDraft, onStatusChange, handleTest, t])

  const showForm = !status.configured || replacingKey

  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-[11px] text-foreground-subtle space-y-2">
      <div className="font-medium text-foreground">{t('plusCatalog.plus')}</div>
      <div>
        <Trans
          i18nKey="plusCatalog.keyIntro"
          components={{
            docs: (
              <a
                href={PLUS_DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              />
            ),
          }}
        />
      </div>

      {status.configured && !replacingKey && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="rounded-md border border-success/30 bg-success/10 px-2 py-1 text-[11px] text-success">
            {t('plusCatalog.keyConfigured')}
          </span>
          <button
            type="button"
            onClick={() => setReplacingKey(true)}
            className="px-3 py-1.5 text-[10px] font-medium rounded-md border border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            {t('plusCatalog.replaceKey')}
          </button>
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={busy}
            className="px-3 py-1.5 text-[10px] font-medium rounded-md border border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
          >
            {t('plusCatalog.testConnection')}
          </button>
          {testResult && <span className="text-[11px] text-foreground-subtle">{testResult}</span>}
        </div>
      )}

      {!status.keyFormatValid && status.configured && !replacingKey && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
          {t('plusCatalog.keyShapeWrong')}
        </div>
      )}

      {showForm && (
        <div className="space-y-1">
          <Field label={t('plusCatalog.keyLabel')}>
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:…"
              autoComplete="off"
              className={REGISTER_SELECT_CLASS}
            />
          </Field>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSaveKey()}
              disabled={keySaving || keyDraft.trim().length === 0}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {keySaving ? t('common.saving') : t('plusCatalog.saveKey')}
            </button>
            {status.configured && replacingKey && (
              <button
                type="button"
                onClick={() => {
                  setReplacingKey(false)
                  setKeyDraft('')
                  setKeyError(null)
                }}
                className="px-3 py-1.5 text-[10px] font-medium rounded-md border border-border text-foreground-subtle hover:text-foreground transition-colors"
              >
                {t('common.cancel')}
              </button>
            )}
          </div>
          {keyError && <div className="text-[11px] text-danger">{keyError}</div>}
          {testResult && showForm && (
            <div className="text-[11px] text-foreground-subtle">{testResult}</div>
          )}
        </div>
      )}
    </div>
  )
}

export function PlusCatalogSection({
  trpc,
  onRegistered,
  onError,
  onPrefillUpload,
  landNodeId,
}: PlusCatalogSectionProps) {
  const { t } = useT()
  const [status, setStatus] = useState<PlusCatalogStatusView | null>(null)
  const [models, setModels] = useState<readonly PlusCatalogModelView[] | null>(null)
  const [busy, setBusy] = useState(false)

  const handleLoadModels = useCallback(async () => {
    setBusy(true)
    try {
      const list = await plusCatalogPlusListModels(trpc)
      setModels(list)
    } catch (err) {
      onError(err instanceof Error ? err.message : t('plusCatalog.listFailed'))
    } finally {
      setBusy(false)
    }
  }, [trpc, onError, t])

  const handleStatusChange = useCallback(
    (next: PlusCatalogStatusView) => {
      setStatus(next)
      if (next.configured) {
        setModels(null)
        void handleLoadModels()
      } else {
        setModels(null)
      }
    },
    [handleLoadModels],
  )

  useEffect(() => {
    let cancelled = false
    plusCatalogPlusStatus(trpc)
      .then((s) => {
        if (cancelled) return
        setStatus(s)
        // The account view IS the catalog — load it as soon as a key exists.
        if (s.configured) void handleLoadModels()
      })
      .catch(() => {
        if (!cancelled) setStatus({ configured: false, keyFormatValid: false })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trpc])

  if (status === null) {
    return <div className="text-xs text-foreground-subtle">{t('plusCatalog.checking')}</div>
  }

  // ── No key: inline form + public fallback catalog ──
  if (!status.configured) {
    return (
      <div className="space-y-4">
        <PlusCatalogKeyPanel trpc={trpc} status={status} onStatusChange={handleStatusChange} />
        <div className="border-t border-border/50 pt-3 space-y-2">
          <div className="text-[11px] text-foreground-subtle">{t('plusCatalog.publicDefault')}</div>
          {PLUS_CATALOG_PUBLIC_CATALOG.map((cat) => (
            <FallbackCatalogCard
              key={cat.id}
              trpc={trpc}
              catalogId={cat.id}
              onRegistered={onRegistered}
              onError={onError}
              onPrefillUpload={onPrefillUpload}
              {...(landNodeId !== undefined ? { landNodeId } : {})}
            />
          ))}
        </div>
      </div>
    )
  }

  // ── Key configured: the REAL account catalog, every family as a card ──
  return (
    <div className="space-y-3">
      <PlusCatalogKeyPanel trpc={trpc} status={status} onStatusChange={handleStatusChange} />
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => void handleLoadModels()}
          disabled={busy}
          className="px-3 py-1.5 text-[10px] font-medium rounded-md border border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
        >
          {t('plusCatalog.refreshList')}
        </button>
      </div>

      {models === null && (
        <div className="text-xs text-foreground-subtle">{t('plusCatalog.loadingModels')}</div>
      )}

      {models !== null && (
        <PlusCatalogBrowser
          models={models}
          trpc={trpc}
          onRegistered={onRegistered}
          onError={onError}
          {...(landNodeId !== undefined ? { landNodeId } : {})}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fallback card — the publicly downloadable plus catalog default (no key)
// ---------------------------------------------------------------------------

function FallbackCatalogCard({
  trpc,
  catalogId,
  onRegistered,
  onError,
  onPrefillUpload,
  landNodeId,
}: {
  readonly trpc: Trpc
  readonly catalogId: string
  readonly onRegistered: (message: string) => void
  readonly onError: (message: string) => void
  readonly onPrefillUpload: (prefill: UploadPrefill) => void
  readonly landNodeId?: string
}) {
  const { t } = useT()
  const cat = PLUS_CATALOG_PUBLIC_CATALOG.find((c) => c.id === catalogId)
  const [importing, setImporting] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [modal, setModal] = useState<{
    title: string
    steps: ImportProgressStep[]
    progress: null
    logs: readonly string[]
    status: 'running' | 'success' | 'error'
    errorMessage?: string
    sessionId: string
  } | null>(null)
  const tfliteNodes = useTfliteNodes(trpc, cat?.format === 'tflite')
  const [landNode, setLandNode] = useState<string>('')
  useEffect(() => {
    if (landNodeId !== undefined && landNodeId.length > 0) {
      setLandNode(landNodeId)
      return
    }
    if (tfliteNodes && tfliteNodes.length > 0 && landNode === '') {
      setLandNode(tfliteNodes[0]!)
    }
  }, [tfliteNodes, landNode, landNodeId])
  if (!cat) return null
  const tfliteBlocked =
    cat.format === 'tflite' && (tfliteNodes === null || tfliteNodes.length === 0)
  const effectiveLand =
    landNodeId !== undefined && landNodeId.length > 0
      ? landNodeId
      : landNode.length > 0
        ? landNode
        : undefined
  const canLand = effectiveLand !== undefined && !tfliteBlocked
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 space-y-2">
      {modal !== null && (
        <ImportProgressModal
          title={modal.title}
          steps={modal.steps}
          progress={modal.progress}
          logs={modal.logs}
          status={modal.status}
          {...(modal.errorMessage !== undefined ? { errorMessage: modal.errorMessage } : {})}
          onClose={() => setModal(null)}
        />
      )}
      <div className="text-xs text-foreground font-medium">{cat.label}</div>
      <div className="text-[11px] text-foreground-subtle">
        {cat.notes} · {cat.sizeMB} MB · {cat.inputSize}×{cat.inputSize} ·{' '}
        <span className="font-mono">{cat.postprocessor ?? 'default'}</span>
      </div>
      {cat.format === 'tflite' && <TfliteGateNote nodes={tfliteNodes} />}
      {landNodeId === undefined &&
        cat.format === 'tflite' &&
        tfliteNodes !== null &&
        tfliteNodes.length > 0 && (
          <label className="flex items-center gap-2 text-[11px] text-foreground">
            <span className="text-foreground-subtle uppercase tracking-wide text-[10px]">
              {t('common.landOn')}
            </span>
            <select
              className="bg-surface border border-border rounded px-2 py-0.5 text-[11px]"
              value={landNode}
              onChange={(e) => setLandNode(e.target.value)}
            >
              {tfliteNodes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
      {landNodeId !== undefined && (
        <p className="text-[10px] text-foreground-subtle">
          <Trans
            i18nKey="plusCatalog.landOnNode"
            values={{ nodeId: landNodeId }}
            components={{ mono: <span className="font-mono" /> }}
          />
        </p>
      )}
      <DisplayNameField value={displayName} onChange={setDisplayName} defaultName={cat.label} />
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => {
            setImporting(true)
            const target = canLand ? effectiveLand : undefined
            const title = t('plusCatalog.opTitle', { label: cat.label })
            const sessionId = startOperationSession({
              kind: 'import',
              title,
              modelId: cat.id,
              format: cat.format,
              ...(target !== undefined ? { nodeId: target } : {}),
              logs: [t('plusCatalog.opLog', { modelId: cat.id })],
            })
            setModal({
              title,
              steps: [
                { id: 'import', label: t('plusCatalog.opStepDownload'), status: 'active' },
                ...(target !== undefined
                  ? [
                      {
                        id: 'land',
                        label: t('importOp.landStep', { nodeId: target }),
                        status: 'pending' as const,
                      },
                    ]
                  : []),
              ],
              progress: null,
              logs: [t('plusCatalog.opLog', { modelId: cat.id })],
              status: 'running',
              sessionId,
            })
            const operatorName = importNameOf(displayName)
            importPlusCatalogCatalogModel(trpc, {
              catalogId: cat.id,
              ...(operatorName !== undefined ? { name: operatorName } : {}),
              ...(target !== undefined ? { targetNodeId: target } : {}),
            })
              .then((result) => {
                const message =
                  target !== undefined
                    ? t('plusCatalog.registeredLanded', {
                        modelId: result.modelId,
                        nodeId: target,
                        size: (result.bytes / 1e6).toFixed(1),
                      })
                    : t('plusCatalog.registered', {
                        modelId: result.modelId,
                        size: (result.bytes / 1e6).toFixed(1),
                      })
                appendOperationLog(sessionId, message)
                finishOperationSession(sessionId, { status: 'success' })
                setModal((m) =>
                  m === null
                    ? m
                    : {
                        ...m,
                        status: 'success',
                        logs: [...m.logs, message],
                        steps: m.steps.map((s) => ({ ...s, status: 'done' })),
                      },
                )
                onRegistered(message)
              })
              .catch((err: unknown) => {
                const message =
                  err instanceof Error ? err.message : t('plusCatalog.catalogImportFailed')
                finishOperationSession(sessionId, { status: 'error', errorMessage: message })
                setModal((m) =>
                  m === null
                    ? m
                    : {
                        ...m,
                        status: 'error',
                        errorMessage: message,
                        steps: m.steps.map((s) =>
                          s.status === 'active' ? { ...s, status: 'error' } : s,
                        ),
                      },
                )
                onError(message)
              })
              .finally(() => setImporting(false))
          }}
          disabled={importing || tfliteBlocked || isDisplayNameInvalid(displayName)}
          className="px-4 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {importing
            ? t('common.importing')
            : canLand
              ? t('plusCatalog.importLand', { nodeId: effectiveLand })
              : t('common.register')}
        </button>
        <button
          onClick={() =>
            onPrefillUpload({
              sourceLabel: cat.label,
              format: cat.format,
              ...(cat.postprocessor !== undefined ? { postprocessor: cat.postprocessor } : {}),
              inputSize: cat.inputSize,
              labels: cat.labels,
            })
          }
          className="px-3 py-1.5 text-[10px] font-medium rounded-md border border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
        >
          {t('plusCatalog.prefillCustom')}
        </button>
      </div>
    </div>
  )
}
