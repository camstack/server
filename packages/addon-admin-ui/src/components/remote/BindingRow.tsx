/**
 * One role of the remote and what it does. An infrared binding (from an
 * import) shows its transmitter and can be sent through another one; any other
 * binding is edited as an Action step — the common device and command pickers.
 * Test sends the SAVED command, so it is offered only for a role the device
 * already has saved.
 */
import type { RemoteBinding, RemoteBindingAction } from '@camstack/types'
import { Badge, Button, Select } from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AutomationDevice } from '../../pages/build/automation/automation-data'
import { CommandStep } from '../../pages/build/flow/CommandStep'
import { humanRole } from './layout-model'
import {
  type BindableRole,
  BLANK_ACTION,
  isCompleteAction,
  transmitterOf,
  withTransmitter,
} from './remote-config-model'

export interface BindingRowProps {
  readonly role: BindableRole
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

export function BindingRow({
  role,
  binding,
  devices,
  transmitters,
  testable,
  testResult,
  onBind,
  onClear,
  onTest,
}: BindingRowProps): ReactNode {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const name = role.name ?? t(`remote.role.${role.role}`, humanRole(role.role))
  const irTransmitter = binding === undefined ? null : transmitterOf(binding)
  const complete = binding !== undefined && isCompleteAction(binding.action)
  const open = editing || (binding !== undefined && irTransmitter === null)
  return (
    <li
      className="space-y-2 rounded border border-border bg-surface p-2"
      data-testid={`binding-${role.role}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{name}</span>
        {role.custom && <Badge variant="neutral">{t('remote.bindings.custom')}</Badge>}
        {!role.inLayout && <Badge variant="warning">{t('remote.bindings.notInLayout')}</Badge>}
        {irTransmitter !== null && <Badge variant="info">{t('remote.bindings.infrared')}</Badge>}
        {binding === undefined && (
          <span className="text-xs text-foreground-subtle">{t('remote.bindings.native')}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {binding === undefined && !editing && (
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
          )}
          {binding !== undefined && (
            <>
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
      </div>
      {irTransmitter !== null && binding !== undefined && (
        <Select
          aria-label={t('remote.bindings.transmitterFor', { name })}
          value={String(irTransmitter)}
          options={transmitters.map((d) => ({ value: String(d.id), label: d.name }))}
          onChange={(e) => onBind(withTransmitter(binding, Number(e.target.value)).action)}
          data-testid={`transmitter-${role.role}`}
        />
      )}
      {open && irTransmitter === null && binding !== undefined && (
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
      {testResult !== null && (
        <p
          role="status"
          className="text-xs text-foreground-muted"
          data-testid={`result-${role.role}`}
        >
          {testResult}
        </p>
      )}
    </li>
  )
}
