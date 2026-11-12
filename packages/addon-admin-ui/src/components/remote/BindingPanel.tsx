/**
 * The selected button, read top to bottom: what it does in plain words, the
 * transmitter it goes through, the code it sends (an infrared train in µs, or
 * the capability call) the moment the button is selected, then the actions —
 * Change, Test, Clear — and the device / command pickers while changing. Only
 * the selected button's binding is rendered; the grid is the list. Test sends
 * the SAVED command once.
 */
import { type RemoteBinding, type RemoteBindingAction, remoteRoleIcon } from '@camstack/types'
import {
  Badge,
  Button,
  CopyButton,
  FormField,
  Select,
  useDisplayIconResolver,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AutomationDevice } from '../../pages/build/automation/automation-data'
import { CommandStep } from '../../pages/build/flow/CommandStep'
import { bindingOfCommand, commandOfBinding } from './remote-command'
import {
  type BindingCode,
  type BindingDescription,
  bindingCode,
  deviceLabel,
  describeBinding,
} from './binding-summary'
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

/** One labelled row of the panel. */
function Row({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className="grid gap-1 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-2">
      <dt className="text-xs text-foreground-muted">{label}</dt>
      <dd className="min-w-0 text-xs text-foreground">{children}</dd>
    </div>
  )
}

/** The code as the transmitter or the capability receives it, with a copy button. */
function CodeBlock({
  code,
  role,
}: {
  readonly code: BindingCode
  readonly role: string
}): ReactNode {
  const { t } = useTranslation()
  const caption =
    code.kind === 'infrared'
      ? [
          t('remote.panel.codeRaw', { count: code.pulses }),
          ...(code.carrierKhz === null
            ? []
            : [t('remote.panel.codeCarrier', { khz: code.carrierKhz })]),
        ].join(' · ')
      : t('remote.panel.callCode')
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-foreground-subtle">{caption}</span>
        <CopyButton value={code.text} srLabel={t('remote.panel.copyCode')} />
      </div>
      <pre
        className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-surface p-2 font-mono text-[11px] leading-snug text-foreground"
        data-testid={`code-${role}`}
      >
        {code.text}
      </pre>
    </div>
  )
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
  const code = binding === undefined ? null : bindingCode(binding.action)
  // A stored call the vocabulary cannot name stays read-only (the rows above) until Change.
  const unrepresentable =
    binding !== undefined &&
    irTransmitter === null &&
    binding.action.cap !== '' &&
    commandOfBinding(binding.action).actionId === ''
  const pickCommand =
    binding !== undefined && irTransmitter === null && (editing || (!complete && !unrepresentable))
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
      <dl className="space-y-2" data-testid="binding-description">
        <Row label={t('remote.panel.does')}>
          <span
            className={binding === undefined ? 'text-foreground-subtle' : undefined}
            data-testid={`summary-${role.role}`}
          >
            <DescriptionText description={description} />
          </span>
          {complete && (
            <span className="block text-foreground-muted">{t('remote.panel.repeatValue')}</span>
          )}
        </Row>
        {irTransmitter !== null && binding !== undefined && (
          <Row label={t('remote.panel.through')}>
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
          </Row>
        )}
        {code !== null && (
          <Row label={t('remote.panel.code')}>
            <CodeBlock code={code} role={role.role} />
          </Row>
        )}
      </dl>
      {pickCommand && binding !== undefined && (
        <FormField label={t('commands.change')}>
          <CommandStep
            step={commandOfBinding(binding.action)}
            devices={devices}
            variables={[]}
            singleTarget
            // a selected button never pops the modal: Choose opens it; Change on a
            // read-only call already was the click
            autoOpen={unrepresentable}
            onChange={(next) => {
              const action = bindingOfCommand(next)
              if (action !== null) onBind(action)
            }}
          />
        </FormField>
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
            {irTransmitter === null && (complete || unrepresentable) && !editing && (
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
