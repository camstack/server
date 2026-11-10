/**
 * The rule dialog's Actions tab: which Actions each hook edge starts, and the buttons
 * the notification carries.
 *
 * Actions are authored on the Build → Actions page. Here the operator only names them
 * (planning#473): a rule or a button runs an existing Action by id, it never defines
 * steps of its own.
 */

import type { ActionEntry, NcRuleNotificationButton } from '@camstack/types'
import type { ReactNode } from 'react'
import { Button, Input, Select } from '@camstack/ui-library'
import { AlertTriangle, ExternalLink, Plus, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { TRIGGER_ALARM_PRESET } from '../build/actions/action-draft'
import { Trans, useTranslation } from 'react-i18next'
import {
  NC_ACTION_ICON_OPTIONS,
  NC_HOOK_KEYS,
  NC_HOOK_LABELS,
  NC_HOOK_MAX_ACTIONS,
  type NcHookKey,
  type NcRuleActionsFormState,
  newButton,
  validateRuleActions,
} from './notification-rule-actions'

/** Where an Action is made: the Actions section of Build, create dialog open. */
export const CREATE_ACTION_PATH = '/build?tab=actions&create=1'

/** The same door, prefilled with one `alarm-panel.trigger` step. */
export const TRIGGER_ALARM_ACTION_PATH = `/build?tab=actions&create=1&preset=${TRIGGER_ALARM_PRESET}`

export interface NotificationRuleActionsProps {
  readonly value: NcRuleActionsFormState
  readonly onChange: (next: NcRuleActionsFormState) => void
  /** The Actions the hub lists (`actions.list`). */
  readonly actions: readonly ActionEntry[]
  /** When false, hide validation banners (new rule before first Create). */
  readonly showProblems?: boolean
}

const FIELD = 'mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs'
const LABEL = 'block text-[11px] font-medium text-foreground'

function SectionHeader({
  title,
  description,
  children,
}: {
  readonly title: string
  readonly description: string
  readonly children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <h4 className="text-xs font-semibold text-foreground">{title}</h4>
        <p className="text-[11px] text-foreground-subtle">{description}</p>
      </div>
      {children !== undefined && (
        <div className="flex flex-wrap items-center gap-1">{children}</div>
      )}
    </div>
  )
}

/** The jump to the Actions page, in a new tab so the open rule dialog is not lost. */
function CreateActionLink() {
  const { t } = useTranslation()
  return (
    <Link
      to={CREATE_ACTION_PATH}
      target="_blank"
      rel="noopener noreferrer"
      title={t(
        'system.notificationRuleActions.createActionHint',
        'Opens the Actions page in a new tab. Reopen the list here afterwards.',
      )}
      className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
    >
      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
      {t('system.notificationRuleActions.createActionLink', 'Create a new Action')}
    </Link>
  )
}

/** Opens the Actions editor prefilled with one press of the alarm panel. */
function TriggerAlarmLink() {
  const { t } = useTranslation()
  return (
    <Link
      to={TRIGGER_ALARM_ACTION_PATH}
      target="_blank"
      rel="noopener noreferrer"
      title={t(
        'system.notificationRuleActions.presetAlarmHint',
        "Presses the alarm panel. The panel's entry delay still runs, and a disarm during it cancels the alarm.",
      )}
      className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
    >
      {t('system.notificationRuleActions.presetAlarm', 'Trigger the alarm')}
    </Link>
  )
}

/** One Action chosen from the hub's list; a stored id the hub no longer lists stays visible. */
function ActionSelect({
  value,
  actions,
  onChange,
}: {
  readonly value: string
  readonly actions: readonly ActionEntry[]
  readonly onChange: (actionId: string) => void
}) {
  const { t } = useTranslation()
  const missing = value !== '' && !actions.some((a) => a.id === value)
  return (
    <Select
      wrapperClassName="block w-full"
      className={FIELD}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {value === '' && (
        <option value="">{t('system.notificationRuleActions.pickAction', 'Pick an Action')}</option>
      )}
      {missing && (
        <option value={value}>
          {t('system.notificationRuleActions.missingAction', 'Missing Action ({{id}})', {
            id: value,
          })}
        </option>
      )}
      {actions.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </Select>
  )
}

export function NotificationRuleActions({
  value,
  onChange,
  actions,
  showProblems = true,
}: NotificationRuleActionsProps) {
  const { t } = useTranslation()
  const knownIds = new Set(actions.map((a) => a.id))
  const problems = validateRuleActions(value, knownIds)

  const setHook = (key: NcHookKey, next: readonly string[]): void =>
    onChange({ ...value, [key]: next })

  const setButton = (index: number, next: NcRuleNotificationButton): void =>
    onChange({ ...value, buttons: value.buttons.map((b, i) => (i === index ? next : b)) })

  return (
    <div className="space-y-4">
      {showProblems && problems.length > 0 ? (
        <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
          {problems.map((p) => (
            <p key={p.message}>{p.message}</p>
          ))}
        </div>
      ) : null}

      {actions.length === 0 && (
        <p className="rounded border border-border px-3 py-2 text-[11px] text-foreground-subtle">
          {t(
            'system.notificationRuleActions.noActionsYet',
            'There are no Actions yet. Create one on the Actions page — a rule or a button runs an Action, it does not define its own steps.',
          )}{' '}
          <CreateActionLink /> <TriggerAlarmLink />
        </p>
      )}

      {NC_HOOK_KEYS.map((key) => (
        <HookSection
          key={key}
          hookKey={key}
          actionIds={value[key]}
          actions={actions}
          onChange={(next) => setHook(key, next)}
        />
      ))}

      <section className="space-y-2">
        <SectionHeader
          title={t(
            'system.notificationRuleActions.buttonsOnTheNotification',
            'Buttons on the notification',
          )}
          description={t(
            'system.notificationRuleActions.eachButtonRunsOneAction',
            'Each button runs one Action when tapped.',
          )}
        >
          <Button
            size="sm"
            variant="ghost"
            type="button"
            disabled={actions.length === 0}
            onClick={() =>
              onChange({
                ...value,
                buttons: [...value.buttons, newButton(value.buttons.length, actions[0]?.id ?? '')],
              })
            }
          >
            <Plus className="h-3.5 w-3.5 shrink-0" /> {t('system.notificationRuleActions.button')}
          </Button>
          <CreateActionLink />
          <TriggerAlarmLink />
        </SectionHeader>

        {value.buttons.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <Trans
                i18nKey="system.notificationRuleActions.buttonLinkNote"
                components={{ b: <strong /> }}
              />
            </span>
          </div>
        )}

        {value.buttons.length === 0 ? (
          <p className="rounded border border-border px-3 py-2 text-[11px] text-foreground-subtle">
            {t(
              'system.notificationRuleActions.noButtonsTheNotificationArrives',
              'No buttons. The notification arrives with nothing to tap.',
            )}
          </p>
        ) : (
          value.buttons.map((button, index) => (
            <ButtonRow
              key={`btn-${String(index)}`}
              button={button}
              actions={actions}
              onChange={(next) => setButton(index, next)}
              onRemove={() =>
                onChange({ ...value, buttons: value.buttons.filter((_, i) => i !== index) })
              }
            />
          ))
        )}
      </section>
    </div>
  )
}

function HookSection({
  hookKey,
  actionIds,
  actions,
  onChange,
}: {
  readonly hookKey: NcHookKey
  readonly actionIds: readonly string[]
  readonly actions: readonly ActionEntry[]
  readonly onChange: (next: readonly string[]) => void
}) {
  const { t } = useTranslation()
  const meta = NC_HOOK_LABELS[hookKey]
  return (
    <section className="space-y-2">
      <SectionHeader title={meta.title} description={meta.hint}>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={actionIds.length >= NC_HOOK_MAX_ACTIONS || actions.length === 0}
          onClick={() => onChange([...actionIds, actions[0]?.id ?? ''])}
        >
          <Plus className="h-3.5 w-3.5" /> {t('system.notificationRuleActions.addAction')}
        </Button>
      </SectionHeader>
      {actionIds.length === 0 ? (
        <p className="rounded border border-border px-3 py-2 text-[11px] text-foreground-subtle">
          {t('system.notificationRuleActions.nothingOnThisEdge', 'Nothing on this edge.')}
        </p>
      ) : (
        actionIds.map((actionId, index) => (
          <div
            key={`${hookKey}-${String(index)}`}
            className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3"
          >
            <div className="min-w-0 flex-1">
              <label className={LABEL}>
                {t('system.notificationRuleActions.action', 'Action')}
              </label>
              <ActionSelect
                value={actionId}
                actions={actions}
                onChange={(next) => onChange(actionIds.map((id, i) => (i === index ? next : id)))}
              />
            </div>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => onChange(actionIds.filter((_, i) => i !== index))}
              title={t('common.remove', 'Remove')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))
      )}
    </section>
  )
}

function ButtonRow({
  button,
  actions,
  onChange,
  onRemove,
}: {
  readonly button: NcRuleNotificationButton
  readonly actions: readonly ActionEntry[]
  readonly onChange: (next: NcRuleNotificationButton) => void
  readonly onRemove: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
      <div className="w-28">
        <label className={LABEL}>{t('system.notificationRuleActions.id', 'Id')}</label>
        <Input
          className="mt-1"
          value={button.id}
          onChange={(e) => onChange({ ...button, id: e.target.value })}
        />
      </div>
      <div className="min-w-0 flex-1">
        <label className={LABEL}>{t('system.notificationRuleActions.label', 'Label')}</label>
        <Input
          className="mt-1"
          value={button.label}
          onChange={(e) => onChange({ ...button, label: e.target.value })}
        />
      </div>
      <div className="min-w-0 flex-1">
        <label className={LABEL}>{t('system.notificationRuleActions.action', 'Action')}</label>
        <ActionSelect
          value={button.actionId}
          actions={actions}
          onChange={(actionId) => onChange({ ...button, actionId })}
        />
      </div>
      <div className="w-32">
        <label className={LABEL}>{t('system.notificationRuleActions.icon', 'Icon')}</label>
        <Select
          wrapperClassName="inline-block w-auto"
          className={FIELD}
          value={button.icon ?? ''}
          onChange={(e) => {
            const { icon: _drop, ...rest } = button
            const chosen = NC_ACTION_ICON_OPTIONS.find((o) => o.value === e.target.value)
            onChange(chosen === undefined ? rest : { ...rest, icon: chosen.value })
          }}
        >
          <option value="">—</option>
          {NC_ACTION_ICON_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      <Button
        size="sm"
        variant="ghost"
        type="button"
        onClick={onRemove}
        title={t('common.remove', 'Remove')}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
