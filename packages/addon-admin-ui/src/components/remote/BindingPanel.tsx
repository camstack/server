/**
 * The action of the selected button: what it does in plain words (the target
 * device and the command it sends), and its secondary actions — Test, Clear,
 * and the device / command pickers to change it. Only the selected button's
 * action is rendered; the grid is the list. Test sends the SAVED command once.
 */
import { type RemoteBinding, type RemoteBindingAction, remoteRoleIcon } from '@camstack/types'
import { Badge, Button, Select, useDisplayIconResolver } from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AutomationDevice } from '../../pages/build/automation/automation-data'
import { CommandStep } from '../../pages/build/flow/CommandStep'
import { type BindingDescription, deviceLabel, describeBinding } from './binding-summary'
import {
  type BindableRole,
  BLANK_ACTION,
  isCompleteAction,
  transmitterOf,
  withTransmitter,
} from './remote-config-model'

export interface BindingPanelProps {
  readonly role: BindableRole
  readonly name: string
  readonly binding: RemoteBinding | undefined
  readonly devices: readonly AutomationDevice[]
  readonly transmitters: readonly AutomationDevice[]
  /** The saved config has a command for this role, so a press can be tested. */
  readonly testable: boolean
  /** The last test's outcome, as a sentence; null before any. */
  readonly testResult: string | null
  readonly onBind: (action: RemoteBindingAction) => void
  readonly onClear: () => void
  readonly onTest: () => void
}

function DescriptionText({ description }: { readonly description: BindingDescription }): ReactNode {
  const { t } = useTranslation()
  switch (description.kind) {
    case 'unbound':
      return t('remote.panel.unbound')
    case 'incomplete':
      return t('remote.panel.incomplete')
    case 'infrared':
      if (description.pulses === null) {
        return t('remote.panel.infrared', { target: description.target })
      }
      return description.carrierKhz === null
        ? t('remote.panel.infraredPulses', {
            count: description.pulses,
            target: description.target,
          })
        : t('remote.panel.infraredPulsesCarrier', {
            count: description.pulses,
            khz: description.carrierKhz,
            target: description.target,
          })
    case 'call':
      return t('remote.panel.call', {
        call: description.call,
        target: description.target,
      })
  }
}

export function BindingPanel({
  role,
  name,
  binding,
  devices,
  transmitters,
  testable,
  testResult,
  onBind,
  onClear,
  onTest,
}: BindingPanelProps): ReactNode {
  const { t } = useTranslation()
  const RoleIcon = useDisplayIconResolver()(remoteRoleIcon(role.role))
  const [editing, setEditing] = useState(false)
  const complete = binding !== undefined && isCompleteAction(binding.action)
  const irTransmitter = binding === undefined ? null : transmitterOf(binding)
  const description = describeBinding(binding?.action, devices)
  const args =
    description.kind === 'infrared' || description.kind === 'call' ? description.args : []
  const pickCommand = binding !== undefined && irTransmitter === null && (editing || !complete)
  return (
    <aside
      className="min-w-0 space-y-3 rounded border border-border bg-surface p-3"
      data-testid="binding-panel"
      aria-label={t('remote.panel.title', { name })}
    >
      <div className="flex flex-wrap items-center gap-2">
        {RoleIcon !== undefined && (
          <RoleIcon className="h-4 w-4 shrink-0 text-foreground-muted" aria-hidden />
        )}
        <h4 className="text-sm font-medium text-foreground">{name}</h4>
        {role.custom && <Badge variant="neutral">{t('remote.bindings.custom')}</Badge>}
        {!role.inLayout && <Badge variant="warning">{t('remote.bindings.notInLayout')}</Badge>}
        {irTransmitter !== null && <Badge variant="info">{t('remote.bindings.infrared')}</Badge>}
      </div>
      <div className="space-y-1" data-testid="binding-description">
        <p
          className={
            binding === undefined ? 'text-xs text-foreground-subtle' : 'text-xs text-foreground'
          }
          data-testid={`summary-${role.role}`}
        >
          <DescriptionText description={description} />
        </p>
        {args.length > 0 && (
          <p className="break-words text-xs text-foreground-muted">
            {t('remote.panel.withArgs', {
              args: args.map((a) => `${a.name} ${a.value}`).join(', '),
            })}
          </p>
        )}
        {complete && (
          <p className="text-xs text-foreground-muted">{t('remote.panel.repeatValue')}</p>
        )}
      </div>
      {irTransmitter !== null && binding !== undefined && (
        <Select
          aria-label={t('remote.bindings.transmitterFor', { name })}
          value={String(irTransmitter)}
          options={transmitters.map((d) => ({
            value: String(d.id),
            label: deviceLabel(d),
          }))}
          onChange={(e) => onBind(withTransmitter(binding, Number(e.target.value)).action)}
          data-testid={`transmitter-${role.role}`}
        />
      )}
      {pickCommand && binding !== undefined && (
        <CommandStep
          step={binding.action}
          devices={devices}
          variables={[]}
          onChange={(next) => {
            if (typeof next.deviceId !== 'number') return
            onBind({ ...next, deviceId: next.deviceId })
          }}
        />
      )}
      <div className="flex flex-wrap items-center gap-1">
        {binding === undefined ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(true)
              onBind(BLANK_ACTION)
            }}
            data-testid={`bind-${role.role}`}
          >
            {t('remote.bindings.bind')}
          </Button>
        ) : (
          <>
            {irTransmitter === null && complete && !editing && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing(true)}
                data-testid={`edit-${role.role}`}
              >
                {t('commands.change')}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={!testable || !complete}
              title={testable ? undefined : t('remote.bindings.saveToTest')}
              onClick={onTest}
              data-testid={`test-${role.role}`}
            >
              {t('remote.bindings.test')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false)
                onClear()
              }}
              data-testid={`clear-${role.role}`}
            >
              {t('remote.bindings.clear')}
            </Button>
          </>
        )}
      </div>
      {testResult !== null && (
        <p
          role="status"
          className="text-xs text-foreground-muted"
          data-testid={`result-${role.role}`}
        >
          {testResult}
        </p>
      )}
    </aside>
  )
}
