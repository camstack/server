/**
 * Settings for an Installed CamStack model on one inference accelerator.
 * Same store as Pipeline → node → steps×accelerators (`AgentStepEditor`).
 */
import { useCallback, useEffect, useState } from 'react'
import { acceleratorLabel, AgentStepEditor, type AddonPageProps } from '@camstack/ui-library'
import type { DeviceStepConfig, NodeInferenceDevice, PipelineAddonSchema } from '@camstack/types'
import { listPipelineAddon, setAgentInferenceDevices } from '../ui/api.js'
import { applyStepSettingsOnDevice } from '../ui/installed-activation.js'
import { useT } from '../i18n/index.js'

interface InstalledSettingsModalProps {
  readonly trpc: AddonPageProps['trpc']
  readonly nodeId: string
  readonly stepId: string
  readonly modelId: string
  readonly modelName: string
  readonly devices: readonly NodeInferenceDevice[]
  readonly deviceKey: string
  readonly onClose: () => void
  readonly onDone: () => void
}

export function InstalledSettingsModal({
  trpc,
  nodeId,
  stepId,
  modelId,
  modelName,
  devices,
  deviceKey,
  onClose,
  onDone,
}: InstalledSettingsModalProps) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addon, setAddon] = useState<PipelineAddonSchema | null>(null)
  const [draft, setDraft] = useState<DeviceStepConfig>({ modelId, settings: {} })

  const settingsDevice = devices.find((d) => d.key === deviceKey)

  useEffect(() => {
    let cancelled = false
    void listPipelineAddon(trpc, stepId, nodeId).then((a) => {
      if (cancelled) return
      setAddon(a)
      const base = settingsDevice?.steps?.[stepId]
      setDraft({
        modelId: base?.modelId ?? modelId,
        settings: { ...base?.settings },
      })
    })
    return () => {
      cancelled = true
    }
  }, [trpc, stepId, nodeId, modelId, settingsDevice])

  const handleSaveSettings = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const inferenceDevices = applyStepSettingsOnDevice(
        devices,
        stepId,
        draft.modelId ?? modelId,
        draft.settings ?? {},
        deviceKey,
      )
      await setAgentInferenceDevices(trpc, { agentNodeId: nodeId, inferenceDevices })
      onDone()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settingsModal.saveFailed'))
    } finally {
      setBusy(false)
    }
  }, [devices, stepId, draft, modelId, deviceKey, trpc, nodeId, onDone, onClose, t])

  const title = t('settingsModal.title', { name: modelName })

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="installed-settings-modal"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground truncate">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-foreground-subtle hover:text-foreground px-2 py-1"
          >
            {t('common.close')}
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          {error && (
            <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          <div className="space-y-2">
            {settingsDevice && (
              <p className="text-[11px] text-foreground-subtle">
                {t('settingsModal.accelerator')}{' '}
                <span className="font-medium text-foreground">
                  {acceleratorLabel(settingsDevice)}
                </span>
              </p>
            )}
            {addon === null ? (
              <p className="text-xs text-foreground-subtle animate-pulse">
                {t('settingsModal.loadingSchema')}
              </p>
            ) : (
              <AgentStepEditor
                addon={addon}
                agentDefault={draft}
                engineFormat={settingsDevice?.format ?? 'onnx'}
                effectiveModelId={modelId}
                onChangeAgentConfig={setDraft}
              />
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-md border border-border text-foreground-subtle hover:text-foreground"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleSaveSettings()}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? t('common.saving') : t('settingsModal.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
