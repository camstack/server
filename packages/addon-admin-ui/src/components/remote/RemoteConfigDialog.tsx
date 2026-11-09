/**
 * The Remote extension's modal (D963, D964) on a media player: pick the layout
 * template, bind each role to an action, set the default transmitter, import a
 * SmartIR file. Nothing is saved until Save; Test sends the SAVED command.
 */
import {
  coreBlockComposition,
  type DeviceInfo,
  type RemoteBindingAction,
  type RemoteConfig,
  type RemoteSendResult,
} from '@camstack/types'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorBox,
  FormField,
  Select,
  useCoreBlocksGetComposition,
  useCoreBlocksUpdateComposition,
  useDeviceManagerListDeviceIdsByCaps,
  useRemoteGetConfig,
  useRemoteListCommands,
  useRemoteSendCommand,
  useRemoteSetConfig,
  useTemplateList,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'
import type { TFunction } from 'i18next'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAutomationDevices } from '../../pages/build/automation/automation-data'
import { BindingPanel } from './BindingPanel'
import { deviceLabel } from './binding-summary'
import { composedBlockIdOf, withMediaPlayerExtension } from './composed-remote'
import { FlipperIrdbPanel } from './FlipperIrdbPanel'
import { layoutOf } from './layout-model'
import { RemoteGrid } from './RemoteGrid'
import {
  applyDraft,
  type BindableRole,
  bindableRoles,
  checkForSave,
  clearBinding,
  IR_CAP,
  setBinding,
} from './remote-config-model'
import { roleName as vocabRoleName } from './role-vocabulary'
import { SmartIrImportPanel } from './SmartIrImportPanel'
import { SourcesPanel } from './SourcesPanel'
import { type TemplateDraft, TemplateEditorBody } from './TemplateEditorDialog'
import { useTemplateSave } from './useTemplateSave'

export interface RemoteConfigDialogProps {
  readonly device: DeviceInfo
  readonly open: boolean
  readonly onClose: () => void
}

export function RemoteConfigDialog({ device, open, onClose }: RemoteConfigDialogProps): ReactNode {
  const { t } = useTranslation()
  const stored = useRemoteGetConfig({ deviceId: device.id }, { enabled: open })
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="xl" placement="sheet-on-mobile" scroll="body">
        {stored.data === undefined ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('remote.dialog.title', { name: device.name })}</DialogTitle>
            </DialogHeader>
            <DialogBody>
              {stored.status === 'error' ? (
                <ErrorBox
                  title={t('remote.dialog.unreadable')}
                  message={stored.error?.message ?? ''}
                  onRetry={() => void stored.refetch()}
                />
              ) : (
                <p role="status" className="text-xs text-foreground-subtle">
                  {t('remote.dialog.loading')}
                </p>
              )}
            </DialogBody>
          </>
        ) : (
          <DialogForm device={device} initial={stored.data} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  )
}

interface FormProps {
  readonly device: DeviceInfo
  readonly initial: RemoteConfig
  readonly onClose: () => void
}

function describeResult(result: RemoteSendResult, t: TFunction): string {
  switch (result.status) {
    case 'sent':
      return t('remote.test.sent', { count: result.sends })
    case 'skipped':
      return t('remote.test.skipped')
    case 'refused':
      return t(`remote.test.refused.${result.reason}`, {
        detail: result.detail ?? '',
      })
  }
}

function DialogForm({ device, initial, onClose }: FormProps): ReactNode {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const [config, setConfig] = useState<RemoteConfig>(initial)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [selectedRole, setSelectedRole] = useState<string | null>(null)
  // The layout editor takes the dialog body over without closing the dialog; the
  // remote's own edits live in `config` and survive the round trip.
  const [editing, setEditing] = useState<TemplateDraft | null>(null)
  const layoutSave = useTemplateSave()
  const [results, setResults] = useState<Readonly<Record<string, string>>>({})
  const templates = useTemplateList({ kind: 'remote' })
  const commands = useRemoteListCommands({ deviceId: device.id })
  const devices = useAutomationDevices()
  const transmitterIds = useDeviceManagerListDeviceIdsByCaps({
    capNames: [IR_CAP],
  })
  const save = useRemoteSetConfig()
  const blockId = composedBlockIdOf(device)
  const block = useCoreBlocksGetComposition(
    { blockId: blockId ?? '' },
    { enabled: blockId !== null },
  )
  const updateBlock = useCoreBlocksUpdateComposition()
  const send = useRemoteSendCommand()

  const transmitters = useMemo(() => {
    const ids = new Set(transmitterIds.data ?? [])
    return devices.filter((d) => ids.has(d.id))
  }, [devices, transmitterIds.data])
  const template = (templates.data ?? []).find((r) => r.id === config.layoutTemplateId)
  const layout = template === undefined ? null : layoutOf(template.payload)
  const roles = useMemo(() => bindableRoles(layout, config), [layout, config])
  const savedRoles = useMemo(
    () => new Set((commands.data?.commands ?? []).map((c) => c.role)),
    [commands.data],
  )
  const roleName = (role: BindableRole): string =>
    role.name ??
    layout?.buttons.find((b) => b.role === role.role)?.label ??
    vocabRoleName(role.role, i18n.language)
  const selected = roles.find((r) => r.role === selectedRole)
  const selectedKey = layout?.buttons.find((b) => b.role === selectedRole)?.id ?? null
  const offLayout = roles.filter((r) => !r.inLayout)
  const check = checkForSave(config)
  const bound = useMemo(() => new Set(Object.keys(config.bindings)), [config.bindings])

  /** A built player has no media-player cap until the remote gives it one (D1004). */
  const attachMediaPlayerFeature = async (): Promise<void> => {
    const view = block.data?.state === 'loaded' ? block.data.view : null
    if (blockId === null || view === null) return
    const composition = coreBlockComposition(view.block)
    const next = composition === null ? null : withMediaPlayerExtension(composition)
    if (next === null) return
    await updateBlock.mutateAsync({
      blockId,
      expectedUpdatedAt: view.block.updatedAt,
      block: { composition: next },
    })
  }

  const doSave = async (): Promise<void> => {
    if (check.config === null) return
    setSaveError(null)
    try {
      const result = await save.mutateAsync({
        deviceId: device.id,
        config: check.config,
      })
      if (result.status === 'refused') {
        setSaveError(result.detail)
        return
      }
      await attachMediaPlayerFeature()
      await queryClient.invalidateQueries({ queryKey: [['remote']] })
      onClose()
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }

  const doTest = async (role: string): Promise<void> => {
    try {
      const result = await send.mutateAsync({
        deviceId: device.id,
        role,
        repeat: 1,
      })
      setResults((prev) => ({ ...prev, [role]: describeResult(result, t) }))
    } catch (err: unknown) {
      setResults((prev) => ({
        ...prev,
        [role]: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  const bind = (role: string, action: RemoteBindingAction): void =>
    setConfig((prev) => setBinding(prev, role, action))

  if (editing !== null) {
    return (
      <TemplateEditorBody
        key={editing.id ?? 'new'}
        draft={editing}
        saving={layoutSave.saving}
        error={layoutSave.error}
        back={{
          label: device.name,
          title: t('remote.layout.editorTitle', { name: editing.name }),
          onBack: () => setEditing(null),
        }}
        onSave={(next) =>
          void layoutSave.save(next).then((saved) => {
            if (saved) setEditing(null)
          })
        }
        onClose={() => setEditing(null)}
      />
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('remote.dialog.title', { name: device.name })}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label={t('remote.dialog.template')}>
            <Select
              value={config.layoutTemplateId ?? ''}
              options={[
                { value: '', label: t('remote.dialog.noTemplate') },
                ...(templates.data ?? []).map((r) => ({
                  value: r.id,
                  label: r.name,
                })),
              ]}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  layoutTemplateId: e.target.value === '' ? null : e.target.value,
                }))
              }
              data-testid="remote-template"
            />
          </FormField>
          <FormField label={t('remote.dialog.transmitter')}>
            <Select
              value={
                config.defaultTransmitterId === null ? '' : String(config.defaultTransmitterId)
              }
              options={[
                { value: '', label: t('remote.dialog.noTransmitter') },
                ...transmitters.map((d) => ({
                  value: String(d.id),
                  label: deviceLabel(d),
                })),
              ]}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  defaultTransmitterId: e.target.value === '' ? null : Number(e.target.value),
                }))
              }
              data-testid="remote-transmitter"
            />
          </FormField>
        </div>
        {templates.data !== undefined && templates.data.length === 0 && (
          <p className="text-xs text-foreground-muted">{t('remote.dialog.noTemplatesHint')}</p>
        )}
        {layout !== null && (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,20rem)_1fr]">
            <div className="mx-auto w-full max-w-xs" data-testid="remote-preview">
              <RemoteGrid
                grid={layout}
                label={t('remote.dialog.preview')}
                boundRoles={bound}
                selectedId={selectedKey}
                onSelect={(id) =>
                  setSelectedRole(layout.buttons.find((b) => b.id === id)?.role ?? null)
                }
              />
            </div>
            <div className="min-w-0 space-y-2">
              {selected === undefined ? (
                <p className="text-xs text-foreground-muted" data-testid="binding-hint">
                  {t('remote.panel.hint')}
                </p>
              ) : (
                <BindingPanel
                  key={selected.role}
                  role={selected}
                  name={roleName(selected)}
                  binding={config.bindings[selected.role]}
                  devices={devices}
                  transmitters={transmitters}
                  testable={savedRoles.has(selected.role)}
                  testResult={results[selected.role] ?? null}
                  onBind={(action) => bind(selected.role, action)}
                  onClear={() => setConfig((prev) => clearBinding(prev, selected.role))}
                  onTest={() => void doTest(selected.role)}
                />
              )}
              {offLayout.length > 0 && (
                <FormField
                  label={t('remote.panel.otherCommands')}
                  description={t('remote.panel.pickOtherHint')}
                >
                  <Select
                    value={selected?.inLayout === false ? selected.role : ''}
                    options={[
                      { value: '', label: t('remote.panel.pickOther') },
                      ...offLayout.map((r) => ({
                        value: r.role,
                        label: roleName(r),
                      })),
                    ]}
                    onChange={(e) => setSelectedRole(e.target.value === '' ? null : e.target.value)}
                    data-testid="binding-other"
                  />
                </FormField>
              )}
            </div>
          </div>
        )}
        {template !== undefined && (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                layoutSave.clearError()
                setEditing({
                  id: template.id,
                  kind: template.kind,
                  name: template.name,
                  payload: template.payload,
                })
              }}
              data-testid="remote-edit-layout"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              {t('remote.editTemplate')}
            </Button>
          </div>
        )}
        <SourcesPanel
          config={config}
          onChange={setConfig}
          roleLabel={(role) =>
            roles.find((r) => r.role === role)?.name ?? vocabRoleName(role, i18n.language)
          }
          transmitters={transmitters.map((d) => ({ id: d.id, label: deviceLabel(d) }))}
        />
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">{t('remote.import.title')}</h3>
          <h4 className="text-xs font-medium text-foreground-muted">
            {t('remote.import.smartirTitle')}
          </h4>
          <SmartIrImportPanel
            transmitterId={config.defaultTransmitterId}
            onApply={(draft) => setConfig((prev) => applyDraft(prev, draft))}
          />
          <h4 className="text-xs font-medium text-foreground-muted">{t('remote.flipper.title')}</h4>
          <FlipperIrdbPanel
            transmitterId={config.defaultTransmitterId}
            onApply={(draft) => setConfig((prev) => applyDraft(prev, draft))}
          />
        </section>
        {check.incomplete.length > 0 && (
          <p role="alert" className="text-xs text-warning" data-testid="remote-incomplete">
            {t('remote.dialog.incomplete', { count: check.incomplete.length })}
          </p>
        )}
        {saveError !== null && (
          <p role="alert" className="text-xs text-danger">
            {saveError}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          disabled={check.config === null || save.isPending}
          onClick={() => void doSave()}
          data-testid="remote-save"
        >
          {t('common.save')}
        </Button>
      </DialogFooter>
    </>
  )
}
