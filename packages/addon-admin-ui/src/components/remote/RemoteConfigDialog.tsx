/**
 * The Remote extension's modal (D963, D964) on a media player: pick the layout
 * template, bind each role to an action, set the default transmitter, import a
 * SmartIR file. Nothing is saved until Save; Test sends the SAVED command.
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
  useRemoteSetConfig,
  useTemplateList,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAutomationDevices } from '../../pages/build/automation/automation-data'
import { BindingRow } from './BindingRow'
import { layoutOf } from './layout-model'
import {
  applyDraft,
  bindableRoles,
  checkForSave,
  clearBinding,
  IR_CAP,
  setBinding,
} from './remote-config-model'
import { RemoteGrid } from './RemoteGrid'
import { SmartIrImportPanel } from './SmartIrImportPanel'

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
        <DialogHeader>
          <DialogTitle>{t('remote.dialog.title', { name: device.name })}</DialogTitle>
        </DialogHeader>
        {stored.data === undefined ? (
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
      return t(`remote.test.refused.${result.reason}`, { detail: result.detail ?? '' })
  }
}

function DialogForm({ device, initial, onClose }: FormProps): ReactNode {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [config, setConfig] = useState<RemoteConfig>(initial)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [results, setResults] = useState<Readonly<Record<string, string>>>({})
  const templates = useTemplateList({ kind: 'remote' })
  const commands = useRemoteListCommands({ deviceId: device.id })
  const devices = useAutomationDevices()
  const transmitterIds = useDeviceManagerListDeviceIdsByCaps({ capNames: [IR_CAP] })
  const save = useRemoteSetConfig()
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
  const check = checkForSave(config)
  const bound = useMemo(() => new Set(Object.keys(config.bindings)), [config.bindings])

  const doSave = async (): Promise<void> => {
    if (check.config === null) return
    setSaveError(null)
    try {
      const result = await save.mutateAsync({ deviceId: device.id, config: check.config })
      if (result.status === 'refused') {
        setSaveError(result.detail)
        return
      }
      await queryClient.invalidateQueries({ queryKey: [['remote']] })
      onClose()
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }

  const doTest = async (role: string): Promise<void> => {
    try {
      const result = await send.mutateAsync({ deviceId: device.id, role, repeat: 1 })
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

  return (
    <>
      <DialogBody className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label={t('remote.dialog.template')}>
            <Select
              value={config.layoutTemplateId ?? ''}
              options={[
                { value: '', label: t('remote.dialog.noTemplate') },
                ...(templates.data ?? []).map((r) => ({ value: r.id, label: r.name })),
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
                ...transmitters.map((d) => ({ value: String(d.id), label: d.name })),
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
          <FormField label={t('remote.dialog.power')}>
            <Select
              value={config.power.mode}
              options={[
                { value: 'toggle', label: t('remote.dialog.powerToggle') },
                { value: 'discrete', label: t('remote.dialog.powerDiscrete') },
              ]}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  power: { mode: e.target.value === 'discrete' ? 'discrete' : 'toggle' },
                }))
              }
              data-testid="remote-power"
            />
          </FormField>
        </div>
        {templates.data !== undefined && templates.data.length === 0 && (
          <p className="text-xs text-foreground-muted">{t('remote.dialog.noTemplatesHint')}</p>
        )}
        {layout !== null && (
          <div className="mx-auto w-full max-w-xs" data-testid="remote-preview">
            <RemoteGrid grid={layout} label={t('remote.dialog.preview')} boundRoles={bound} />
          </div>
        )}
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">{t('remote.import.title')}</h3>
          <SmartIrImportPanel
            transmitterId={config.defaultTransmitterId}
            onApply={(draft) => setConfig((prev) => applyDraft(prev, draft))}
          />
        </section>
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">{t('remote.bindings.title')}</h3>
          {roles.length === 0 ? (
            <p className="text-xs text-foreground-muted">{t('remote.bindings.empty')}</p>
          ) : (
            <ul className="space-y-2">
              {roles.map((role) => (
                <BindingRow
                  key={role.role}
                  role={role}
                  binding={config.bindings[role.role]}
                  devices={devices}
                  transmitters={transmitters}
                  testable={savedRoles.has(role.role)}
                  testResult={results[role.role] ?? null}
                  onBind={(action) => bind(role.role, action)}
                  onClear={() => setConfig((prev) => clearBinding(prev, role.role))}
                  onTest={() => void doTest(role.role)}
                />
              ))}
            </ul>
          )}
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
