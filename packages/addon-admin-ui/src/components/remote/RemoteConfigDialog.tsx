/**
 * The Remote extension's modal (D963, D964) on a media player: pick the layout
 * template, bind each role to an action, set the default transmitter, import a
 * SmartIR file. Nothing is written here: "Keep" hands the edited configuration to
 * the Customize tab's draft (the tab's Save writes it, planning#675). Test sends
 * the SAVED command, so a role whose binding changed in the draft is not testable.
 */
import {
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
  useDeviceManagerListDeviceIdsByCaps,
  useRemoteGetConfig,
  useRemoteListCommands,
  useRemoteSendCommand,
  useTemplateList,
} from '@camstack/ui-library'
import { Pencil } from 'lucide-react'
import type { TFunction } from 'i18next'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAutomationDevices } from '../../pages/build/automation/automation-data'
import { BindingPanel } from './BindingPanel'
import { deviceLabel } from './binding-summary'
import { FlipperIrdbPanel } from './FlipperIrdbPanel'
import { layoutOf, RemoteGrid } from '@camstack/ui-library'
import {
  applyDraft,
  type BindableRole,
  bindableRoles,
  checkForSave,
  clearBinding,
  IR_CAP,
  setBinding,
} from './remote-config-model'
import { roleName as vocabRoleName } from '@camstack/ui-library'
import { SmartIrImportPanel } from './SmartIrImportPanel'
import { SourcesPanel } from './SourcesPanel'
import { type TemplateDraft, TemplateEditorBody } from './TemplateEditorDialog'
import { useTemplateSave } from './useTemplateSave'

export interface RemoteConfigDialogProps {
  readonly device: DeviceInfo
  readonly open: boolean
  /** The configuration the tab's draft holds, shown instead of the stored one. */
  readonly kept?: RemoteConfig | null
  /** The operator confirmed the edit: the tab's draft takes this configuration. */
  readonly onKeep: (config: RemoteConfig) => void
  readonly onClose: () => void
}

export function RemoteConfigDialog({
  device,
  open,
  kept = null,
  onKeep,
  onClose,
}: RemoteConfigDialogProps): ReactNode {
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
          <DialogForm
            device={device}
            saved={stored.data}
            initial={kept ?? stored.data}
            onKeep={onKeep}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

interface FormProps {
  readonly device: DeviceInfo
  /** What the capability stores: Test sends this, so it decides which roles are testable. */
  readonly saved: RemoteConfig
  readonly initial: RemoteConfig
  readonly onKeep: (config: RemoteConfig) => void
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

function DialogForm({ device, saved, initial, onKeep, onClose }: FormProps): ReactNode {
  const { t, i18n } = useTranslation()
  const [config, setConfig] = useState<RemoteConfig>(initial)
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
  const send = useRemoteSendCommand()

  const transmitters = useMemo(() => {
    const ids = new Set(transmitterIds.data ?? [])
    return devices.filter((d) => ids.has(d.id))
  }, [devices, transmitterIds.data])
  const template = (templates.data ?? []).find((r) => r.id === config.layoutTemplateId)
  const layout = template === undefined ? null : layoutOf(template.payload)
  const roles = useMemo(() => bindableRoles(layout, config), [layout, config])
  // A role is testable when the capability stores its command AND the draft still binds it as stored.
  const savedRoles = useMemo(
    () =>
      new Set(
        (commands.data?.commands ?? [])
          .map((c) => c.role)
          .filter(
            (role) =>
              JSON.stringify(config.bindings[role]) === JSON.stringify(saved.bindings[role]),
          ),
      ),
    [commands.data, config.bindings, saved.bindings],
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
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          disabled={check.config === null}
          onClick={() => {
            if (check.config === null) return
            onKeep(check.config)
            onClose()
          }}
          data-testid="remote-save"
        >
          {t('customize.table.keep')}
        </Button>
      </DialogFooter>
    </>
  )
}
