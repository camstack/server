/**
 * One member of a notifier group: its on switch, when it receives, which fields and what text, the
 * priority and throttle gates, and a line that says what it would receive (D1071).
 */
import {
  AlarmStateSchema,
  DeviceType,
  type GroupMember,
  type GroupMemberWhen,
  type NotificationField,
} from '@dominevo/types'
import {
  Badge,
  DeviceValuePicker,
  IconButton,
  Input,
  Label,
  Select,
  Switch,
  ToggleChipRow,
  DurationInput,
} from '@dominevo/ui-library'
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { ScheduleField } from '../../pages/system/notification-schedule-field'
import {
  classesText,
  DEFAULT_SCHEDULE,
  eventKindsOff,
  MEMBER_EVENT_KINDS,
  MEMBER_FIELDS,
  previewOf,
  PRIORITY_LEVELS,
  withClassesText,
  withEventKinds,
  withFallbackFor,
  withoutKey,
} from './group-members-model'

const ALARM_STATES = AlarmStateSchema.options
const WHEN_KINDS: readonly GroupMemberWhen['kind'][] = ['always', 'schedule', 'alarm']
const NO_PRIORITY = ''
const NO_FALLBACK = ''

/** A member this one can be a fallback for: its target id and the name to show. */
export interface FallbackChoice {
  readonly targetId: string
  readonly name: string
}

export interface GroupMemberCardProps {
  readonly member: GroupMember
  /** The target's name; the id when the target is gone. */
  readonly name: string
  readonly kindLabel: string
  /** False when the member names a target that no longer exists. */
  readonly known: boolean
  readonly defaultOpen: boolean
  /** The members listed before this one: the ones it can be a fallback for. */
  readonly fallbackChoices: readonly FallbackChoice[]
  readonly onChange: (next: GroupMember) => void
  readonly onRemove: () => void
}

function offFields(member: GroupMember): ReadonlySet<string> {
  const kept = member.fields
  return new Set(kept === undefined ? [] : MEMBER_FIELDS.filter((f) => !kept.includes(f)))
}

export function GroupMemberCard({
  member,
  name,
  kindLabel,
  known,
  defaultOpen,
  fallbackChoices,
  onChange,
  onRemove,
}: GroupMemberCardProps): ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(defaultOpen)
  const when = member.when ?? { kind: 'always' }
  const enabled = member.enabled !== false
  const preview = previewOf(member)
  const fieldLabel = (f: NotificationField): string => t(`notifierGroup.field.${f}`, f)

  const setWhen = (kind: GroupMemberWhen['kind']): void => {
    if (kind === 'always') onChange(withoutKey(member, 'when'))
    else if (kind === 'schedule') onChange({ ...member, when: DEFAULT_SCHEDULE })
    else
      onChange({
        ...member,
        when: { kind: 'alarm', deviceId: 0, states: ['armed_away'] },
      })
  }
  const setTemplate = (key: 'title' | 'body', text: string): void => {
    const next = { ...member.templates, [key]: text }
    if (text === '') delete next[key]
    if (next.title === undefined && next.body === undefined)
      onChange(withoutKey(member, 'templates'))
    else onChange({ ...member, templates: next })
  }

  return (
    <div
      className="rounded-md border border-border bg-surface"
      data-testid={`group-member-${member.targetId}`}
    >
      <div className="flex items-center gap-2 p-2">
        <IconButton
          icon={open ? ChevronDown : ChevronRight}
          variant="ghost"
          size="sm"
          aria-label={
            open
              ? t('notifierGroup.collapse', 'Hide policy')
              : t('notifierGroup.expand', 'Show policy')
          }
          onClick={() => setOpen(!open)}
        />
        <div className="min-w-0 flex-1">
          <p className={`truncate text-sm ${known ? 'text-foreground' : 'text-danger'}`}>
            {known
              ? name
              : t('notifierGroup.missingTarget', 'Missing target {{id}}', {
                  id: name,
                })}
          </p>
          <p className="truncate text-xs text-foreground-muted">{kindLabel}</p>
        </div>
        {!enabled && <Badge variant="default">{t('notifierGroup.paused', 'paused')}</Badge>}
        <Switch
          checked={enabled}
          aria-label={t('notifierGroup.enabled', 'Deliver to this member')}
          onCheckedChange={(on) =>
            onChange(on ? withoutKey(member, 'enabled') : { ...member, enabled: false })
          }
        />
        <IconButton
          icon={Trash2}
          variant="ghost"
          size="sm"
          aria-label={t('notifierGroup.remove', 'Remove {{name}} from the group', { name })}
          onClick={onRemove}
        />
      </div>
      {open && (
        <div className="space-y-3 border-t border-border-subtle p-3">
          <div className="space-y-1">
            <Label>{t('notifierGroup.when', 'Receives')}</Label>
            <Select
              value={when.kind}
              onChange={(e) => {
                const kind = WHEN_KINDS.find((k) => k === e.target.value)
                if (kind !== undefined) setWhen(kind)
              }}
              options={WHEN_KINDS.map((k) => ({
                value: k,
                label: t(`notifierGroup.when_${k}`, k),
              }))}
            />
            {when.kind === 'schedule' && (
              <ScheduleField
                value={when.schedule}
                onChange={(schedule) =>
                  onChange(
                    schedule === undefined
                      ? withoutKey(member, 'when')
                      : { ...member, when: { kind: 'schedule', schedule } },
                  )
                }
                emptyHint={t(
                  'notifierGroup.scheduleEmpty',
                  'Always — add a window to restrict when it receives.',
                )}
              />
            )}
            {when.kind === 'alarm' && (
              <div className="space-y-2">
                <DeviceValuePicker
                  pick="device"
                  noun="device"
                  fixedTypes={[DeviceType.AlarmPanel]}
                  recentKey="notifier-group-alarm"
                  value={when.deviceId > 0 ? { deviceId: when.deviceId } : null}
                  onChange={(picked) =>
                    onChange({
                      ...member,
                      when: { ...when, deviceId: picked?.deviceId ?? 0 },
                    })
                  }
                />
                <ToggleChipRow
                  chips={ALARM_STATES.map((s) => ({
                    id: s,
                    label: t(`notifierGroup.alarm.${s}`, s),
                  }))}
                  off={new Set(ALARM_STATES.filter((s) => !when.states.includes(s)))}
                  allLabel={t('notifierGroup.allStates', 'Any state')}
                  ariaLabel={t('notifierGroup.alarmStates', 'Alarm states that deliver')}
                  onChange={(off) => {
                    const states = ALARM_STATES.filter((s) => !off.has(s))
                    // A member needs at least one state; an emptied selection keeps the previous one.
                    if (states.length > 0) onChange({ ...member, when: { ...when, states } })
                  }}
                />
              </div>
            )}
          </div>

          {(fallbackChoices.length > 0 || member.onlyIfUndelivered !== undefined) && (
            <div className="space-y-1">
              <Label>{t('notifierGroup.fallback', 'Escalation')}</Label>
              <Select
                value={member.onlyIfUndelivered?.[0] ?? NO_FALLBACK}
                aria-label={t('notifierGroup.fallback', 'Escalation')}
                onChange={(e) =>
                  onChange(
                    withFallbackFor(
                      member,
                      e.target.value === NO_FALLBACK ? undefined : e.target.value,
                    ),
                  )
                }
                options={[
                  {
                    value: NO_FALLBACK,
                    label: t('notifierGroup.fallbackAlways', 'Always delivered'),
                  },
                  ...fallbackChoices.map((choice) => ({
                    value: choice.targetId,
                    label: t('notifierGroup.fallbackFor', 'Only if {{name}} did not receive it', {
                      name: choice.name,
                    }),
                  })),
                ]}
              />
            </div>
          )}

          <div className="space-y-1">
            <Label>{t('notifierGroup.eventKinds', 'Only these events')}</Label>
            <ToggleChipRow
              chips={MEMBER_EVENT_KINDS.map((k) => ({
                id: k,
                label: t(`notifierGroup.eventKind.${k}`, k),
              }))}
              off={eventKindsOff(member)}
              allLabel={t('notifierGroup.allEvents', 'All events')}
              ariaLabel={t('notifierGroup.eventKinds', 'Only these events')}
              onChange={(off) =>
                onChange(
                  withEventKinds(
                    member,
                    MEMBER_EVENT_KINDS.filter((k) => !off.has(k)),
                  ),
                )
              }
            />
            <Input
              value={classesText(member)}
              placeholder={t('notifierGroup.classesPlaceholder', 'Any class (e.g. person, car)')}
              aria-label={t('notifierGroup.classes', 'Only these detected classes')}
              onChange={(e) => onChange(withClassesText(member, e.target.value))}
            />
          </div>

          <div className="space-y-1">
            <Label>{t('notifierGroup.fields', 'Fields to deliver')}</Label>
            <ToggleChipRow
              chips={MEMBER_FIELDS.map((f) => ({
                id: f,
                label: fieldLabel(f),
              }))}
              off={offFields(member)}
              allLabel={t('notifierGroup.allFields', 'All')}
              ariaLabel={t('notifierGroup.fields', 'Fields to deliver')}
              onChange={(off) => {
                const kept = MEMBER_FIELDS.filter((f) => !off.has(f))
                onChange(
                  kept.length === MEMBER_FIELDS.length
                    ? withoutKey(member, 'fields')
                    : { ...member, fields: kept },
                )
              }}
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>{t('notifierGroup.titleTemplate', 'Title template')}</Label>
              <Input
                value={member.templates?.title ?? ''}
                placeholder="{{title}}"
                onChange={(e) => setTemplate('title', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>{t('notifierGroup.bodyTemplate', 'Body template')}</Label>
              <Input
                value={member.templates?.body ?? ''}
                placeholder="{{body}}"
                onChange={(e) => setTemplate('body', e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-foreground-subtle">
            {t(
              'notifierGroup.templateHint',
              'Use {{title}} and {{body}} for the notification text. Empty keeps the original.',
            )}
          </p>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>{t('notifierGroup.minPriority', 'Minimum priority')}</Label>
              <Select
                value={member.minPriority === undefined ? NO_PRIORITY : String(member.minPriority)}
                onChange={(e) => {
                  const level = PRIORITY_LEVELS.find((p) => String(p) === e.target.value)
                  onChange(
                    level === undefined
                      ? withoutKey(member, 'minPriority')
                      : { ...member, minPriority: level },
                  )
                }}
                options={[
                  {
                    value: NO_PRIORITY,
                    label: t('notifierGroup.anyPriority', 'Any priority'),
                  },
                  ...PRIORITY_LEVELS.map((p) => ({
                    value: String(p),
                    label: String(p),
                  })),
                ]}
              />
            </div>
            <div className="space-y-1">
              <Label>{t('notifierGroup.throttle', 'At most one per (seconds)')}</Label>
              <DurationInput
                aria-label={t('notifierGroup.throttle', 'At most one per (seconds)')}
                value={member.throttleSec ?? 0}
                min={0}
                onChange={(seconds) =>
                  onChange(
                    seconds > 0
                      ? { ...member, throttleSec: seconds }
                      : withoutKey(member, 'throttleSec'),
                  )
                }
              />
            </div>
          </div>
        </div>
      )}
      <div
        className="border-t border-border-subtle px-3 py-2 text-xs text-foreground-muted"
        data-testid="member-preview"
      >
        <span className="font-medium text-foreground">
          {t('notifierGroup.receives', 'Receives')}:{' '}
        </span>
        {preview.title === '' && preview.body === ''
          ? t('notifierGroup.receivesNothing', 'nothing (every field is off)')
          : [preview.title, preview.body].filter((s) => s !== '').join(' — ')}
      </div>
    </div>
  )
}
