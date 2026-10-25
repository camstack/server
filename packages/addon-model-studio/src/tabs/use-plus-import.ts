/**
 * plus catalog import state for the catalog cards: the registry view (which
 * formats each plus catalog build already has), the progress modal, and the one
 * import routine every format button runs.
 *
 *  - onnx / tflite → download that build's native artifact
 *  - openvino / coreml → download the ONNX first when absent, then convert
 */
import { useCallback, useEffect, useState } from 'react'
import type { AddonPageProps } from '@camstack/ui-library'
import type { ModelFormat } from '@camstack/types'
import {
  ensureModelFormats,
  plusCatalogPlusRegistryId,
  importPlusCatalogModel,
  listAvailability,
  listCustomModels,
  subscribeConvertProgress,
  type ConvertProgressEvent,
  type PlusConversionOutcomeView,
} from '../ui/api.js'
import { entryFormats, nodePresence } from '../ui/model-studio-ui.js'
import {
  appendProgressLog,
  type ImportProgressStep,
  type ImportStepStatus,
} from '../components/ImportProgressModal.js'
import {
  appendOperationLog,
  finishOperationSession,
  replaceOperationLogs,
  startOperationSession,
} from '../ui/operation-sessions.js'
import { translate, useT } from '../i18n/index.js'

type Trpc = AddonPageProps['trpc']

export type NodePresenceList = ReturnType<typeof nodePresence>

export interface PlusImportModal {
  readonly title: string
  readonly steps: ImportProgressStep[]
  readonly progress: ConvertProgressEvent | null
  readonly logs: readonly string[]
  readonly status: 'running' | 'success' | 'error'
  readonly errorMessage?: string
  readonly sessionId: string
}

export interface PlusImportOptions {
  readonly trpc: Trpc
  readonly onRegistered: (message: string) => void
  readonly onError: (message: string) => void
  readonly landNodeId?: string
}

export interface PlusImportState {
  readonly registeredIds: ReadonlySet<string> | null
  readonly registryFormats: Readonly<Record<string, readonly ModelFormat[]>>
  readonly presenceByModel: Readonly<Record<string, NodePresenceList>>
  readonly busyId: string | null
  readonly modal: PlusImportModal | null
  readonly closeModal: () => void
  /**
   * `displayName` titles the progress modal; `operatorName` is the optional
   * display name typed on the card — absent, the hub names the model.
   */
  readonly runImportFormat: (
    plusModelId: string,
    format: ModelFormat,
    displayName: string,
    operatorName?: string,
  ) => Promise<void>
}

/** Per-engine conversion outcomes, verbatim — a failed format is REPORTED
 *  beside the successes, never swallowed. */
export function summarizeConversions(outcomes: readonly PlusConversionOutcomeView[]): string {
  if (outcomes.length === 0) return ''
  const parts = outcomes.map((o) =>
    o.ok
      ? `${o.format} ✓${o.nodeId ? ` (${o.nodeId})` : ''}`
      : `${o.format} ✗ — ${o.error ?? translate('plusImport.conversionFailedWord')}`,
  )
  return translate('plusImport.conversions', { parts: parts.join('; ') })
}

export function usePlusImport({
  trpc,
  onRegistered,
  onError,
  landNodeId,
}: PlusImportOptions): PlusImportState {
  const { t } = useT()
  const [registeredIds, setRegisteredIds] = useState<ReadonlySet<string> | null>(null)
  const [registryFormats, setRegistryFormats] = useState<
    Readonly<Record<string, readonly ModelFormat[]>>
  >({})
  const [presenceByModel, setPresenceByModel] = useState<
    Readonly<Record<string, NodePresenceList>>
  >({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [modal, setModal] = useState<PlusImportModal | null>(null)

  const refreshRegistry = useCallback(async () => {
    try {
      const [modelsList, avail] = await Promise.all([
        listCustomModels(trpc),
        listAvailability(trpc),
      ])
      setRegisteredIds(new Set(modelsList.map((m) => m.entry.id)))
      const formats: Record<string, readonly ModelFormat[]> = {}
      const presence: Record<string, NodePresenceList> = {}
      for (const m of modelsList) {
        formats[m.entry.id] = entryFormats(m.entry)
        presence[m.entry.id] = nodePresence(avail, m.entry.id)
      }
      setRegistryFormats(formats)
      setPresenceByModel(presence)
    } catch {
      setRegisteredIds(null)
      setRegistryFormats({})
      setPresenceByModel({})
    }
  }, [trpc])

  useEffect(() => {
    void refreshRegistry()
  }, [refreshRegistry])

  const runImportFormat = useCallback(
    async (
      plusModelId: string,
      format: ModelFormat,
      displayName: string,
      operatorName?: string,
    ) => {
      const registryId = plusCatalogPlusRegistryId(plusModelId)
      const entryKey = `${registryId}::${format}`
      setBusyId(entryKey)

      const wantsEngine = format === 'openvino' || format === 'coreml'
      const steps: ImportProgressStep[] = [
        { id: 'download', label: t('plusImport.stepDownload'), status: 'active' },
        { id: 'register', label: t('plusImport.stepRegister'), status: 'pending' },
        ...(wantsEngine
          ? [
              {
                id: 'convert',
                label: t('plusImport.stepConvert', {
                  engine: format === 'openvino' ? 'OpenVINO' : 'CoreML',
                }),
                status: 'pending' as const,
              },
            ]
          : format === 'onnx'
            ? [
                {
                  id: 'engines',
                  label: t('plusImport.stepEngines'),
                  status: 'skipped' as const,
                },
              ]
            : []),
      ]
      setModal({
        title: t('plusImport.title', { name: displayName, format }),
        steps,
        progress: null,
        logs: [t('plusImport.start', { format, plusModelId })],
        status: 'running',
        sessionId: startOperationSession({
          kind: wantsEngine ? 'convert' : 'import',
          title: t('plusImport.title', { name: displayName, format }),
          modelId: registryId,
          format,
          ...(landNodeId !== undefined ? { nodeId: landNodeId } : {}),
          logs: [t('plusImport.start', { format, plusModelId })],
        }),
      })

      const patchSteps = (updater: (prev: ImportProgressStep[]) => ImportProgressStep[]) => {
        setModal((m) => (m === null ? m : { ...m, steps: updater([...m.steps]) }))
      }
      const appendLog = (line: string) => {
        setModal((m) => {
          if (m === null) return m
          appendOperationLog(m.sessionId, line)
          return {
            ...m,
            logs: appendProgressLog(m.logs, { phase: 'log', log: line }),
          }
        })
      }
      const mark = (id: string, status: ImportStepStatus) => {
        patchSteps((prev) => prev.map((s) => (s.id === id ? { ...s, status } : s)))
      }

      const sub = subscribeConvertProgress(trpc, (p) => {
        setModal((m) => {
          if (m === null) return m
          const logs = appendProgressLog(m.logs, p)
          replaceOperationLogs(m.sessionId, logs)
          return {
            ...m,
            progress: p.phase === 'log' ? m.progress : p,
            logs,
          }
        })
      })

      try {
        const already = registeredIds?.has(registryId) === true
        const hasFormat = (registryFormats[registryId] ?? []).includes(format)

        if (format === 'onnx' || format === 'tflite') {
          if (hasFormat) {
            appendLog(t('plusImport.alreadyInLibrary', { format }))
            mark('download', 'done')
            mark('register', 'done')
          } else {
            appendLog(t('plusImport.downloadingNative', { format }))
            const result = await importPlusCatalogModel(trpc, {
              plusModelId,
              ...(operatorName !== undefined ? { name: operatorName } : {}),
              ensureFormats: [],
              format: format === 'tflite' ? 'tflite' : 'onnx',
            })
            mark('download', 'done')
            mark('register', 'done')
            const size = (result.bytes / 1e6).toFixed(1)
            appendLog(t('plusImport.registeredLog', { modelId: result.modelId, size }))
            onRegistered(t('plusImport.imported', { modelId: result.modelId, size }))
          }
        } else if (wantsEngine) {
          if (!already) {
            appendLog(t('plusImport.onnxMissing'))
            const result = await importPlusCatalogModel(trpc, {
              plusModelId,
              ...(operatorName !== undefined ? { name: operatorName } : {}),
              ensureFormats: [format],
              format: 'onnx',
            })
            mark('download', 'done')
            mark('register', 'done')
            mark(
              'convert',
              result.conversions.some((c) => c.format === format && c.ok) ? 'done' : 'error',
            )
            const summary = summarizeConversions(result.conversions)
            appendLog(t('plusImport.registeredConv', { modelId: result.modelId, summary }))
            onRegistered(t('plusImport.importedPlus', { modelId: result.modelId, format, summary }))
          } else if (hasFormat) {
            mark('download', 'done')
            mark('register', 'done')
            mark('convert', 'done')
            appendLog(t('plusImport.alreadyPresent', { format, registryId }))
          } else {
            mark('download', 'done')
            mark('register', 'done')
            mark('convert', 'active')
            appendLog(t('plusImport.converting', { format }))
            const result = await ensureModelFormats(trpc, registryId, [format])
            const ok = result.conversions.some((c) => c.format === format && c.ok)
            mark('convert', ok ? 'done' : 'error')
            appendLog(
              t('plusImport.conversionLog', { summary: summarizeConversions(result.conversions) }),
            )
            if (!ok) {
              throw new Error(
                result.conversions.find((c) => c.format === format)?.error ??
                  t('plusImport.conversionFailed', { format }),
              )
            }
            onRegistered(
              t('plusImport.converted', {
                registryId,
                format,
                summary: summarizeConversions(result.conversions),
              }),
            )
          }
        }

        await refreshRegistry()
        setModal((m) => {
          if (m === null) return m
          finishOperationSession(m.sessionId, { status: 'success' })
          return {
            ...m,
            status: 'success',
            steps: m.steps.map((s) =>
              s.status === 'active' || s.status === 'pending' ? { ...s, status: 'done' } : s,
            ),
            progress: null,
          }
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : t('importOp.failed')
        setModal((m) => {
          if (m === null) return m
          finishOperationSession(m.sessionId, {
            status: 'error',
            errorMessage: message,
          })
          return {
            ...m,
            status: 'error',
            errorMessage: message,
            steps: m.steps.map((s) => (s.status === 'active' ? { ...s, status: 'error' } : s)),
          }
        })
        onError(message)
      } finally {
        sub?.unsubscribe()
        setBusyId(null)
      }
    },
    [trpc, registeredIds, registryFormats, refreshRegistry, onRegistered, onError, landNodeId, t],
  )

  const closeModal = useCallback(() => setModal(null), [])

  return {
    registeredIds,
    registryFormats,
    presenceByModel,
    busyId,
    modal,
    closeModal,
    runImportFormat,
  }
}
