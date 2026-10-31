/**
 * The rule dialog's Actions tab: hook bindings and notification buttons.
 *
 * Sequences are authored on Notifications → Sequences. Here the operator only
 * binds to them (or authors a single Do) on each hook edge.
 */

import type {
  NcActionBinding,
  NcRuleAction,
  NcRuleNotificationButton,
  NcSharedSequence,
} from '@camstack/types'
import { normalizeNcCapTarget } from '@camstack/types'
import type { ReactNode } from 'react'
import { Button, Input, Select } from '@camstack/ui-library'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import {
  DeviceDoActionFields,
  type CapDoWire,
  type CapDeviceTarget,
} from '../../components/device-do-action/DeviceDoActionFields'
import {
  NC_ACTION_ICON_OPTIONS,
  NC_HOOK_KEYS,
  NC_HOOK_LABELS,
  type NcHookKey,
  type NcRuleActionsFormState,
  newButton,
  newDoBinding,
  newSequenceBinding,
  validateRuleActions,
} from './notification-rule-actions'
import { type DeviceListState } from './device-selection'
import { Trans, useTranslation } from 'react-i18next'

export interface RuleActionDevice {
  readonly id: number
  readonly name: string
  readonly type?: string
  readonly location?: string | null
}

export interface NotificationRuleActionsProps {
  readonly value: NcRuleActionsFormState
  readonly onChange: (next: NcRuleActionsFormState) => void
  readonly devices: readonly RuleActionDevice[]
  readonly devicesState: DeviceListState
  readonly sequences: readonly NcSharedSequence[]
  /** Create a shared sequence from a preset and return its id. */
  readonly onCreateSequence?: (input: {
    readonly name: string
    readonly minDelaySec?: number
    readonly actions: readonly NcRuleAction[]
  }) => Promise<string>
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

function selectedIdsOf(deviceId: CapDeviceTarget): readonly number[] {
  if (typeof deviceId === 'number') return deviceId > 0 ? [deviceId] : []
  if (Array.isArray(deviceId)) return deviceId.filter((id) => id > 0)
  return []
}

function capActionFromWire(wire: CapDoWire, deviceId: number): NcRuleAction {
  return {
    kind: 'cap',
    deviceId,
    cap: wire.cap,
    method: wire.method,
    ...(wire.args !== undefined ? { args: { ...wire.args } } : {}),
  }
}

/** Expand a multi-device Do wire into one sequence `cap` step per device (schema is scalar). */
export function expandCapActions(wire: CapDoWire): readonly NcRuleAction[] {
  const ids = selectedIdsOf(wire.deviceId)
  if (ids.length === 0) return [capActionFromWire(wire, 0)]
  return ids.map((deviceId) => capActionFromWire(wire, deviceId))
}

/** Expand a multi-device Do wire into one `do` binding per device (schema is scalar). */
export function expandDoBindings(wire: CapDoWire): readonly NcActionBinding[] {
  return expandCapActions(wire).map((action) => ({ kind: 'do' as const, action }))
}

/**
 * The devices a stored cap step names (D983: `target.devices`, or the legacy
 * `deviceId`). A `domain` or `var` target names none here — this editor is a
 * device picker.
 */
function stepDeviceIds(step: Extract<NcRuleAction, { kind: 'cap' }>): readonly number[] {
  const { target } = normalizeNcCapTarget(step)
  return target.kind === 'devices' ? target.ids.filter((id) => id > 0) : []
}

/**
 * Collapse consecutive same-action sequence `cap` steps into one CapDoWire for editing.
 * Returns how many steps were consumed (at least 1). Wait / mismatched steps stop the group.
 */
export function collapseCapGroup(
  actions: readonly NcRuleAction[],
  start: number,
): { readonly wire: CapDoWire; readonly length: number } {
  const first = actions[start]
  if (first === undefined || first.kind !== 'cap') {
    return {
      wire: { deviceId: 0, cap: '', method: '' },
      length: 1,
    }
  }
  const ids: number[] = [...stepDeviceIds(first)]
  let length = 1
  for (let i = start + 1; i < actions.length; i += 1) {
    const next = actions[i]
    if (next === undefined || next.kind !== 'cap') break
    if (
      next.cap !== first.cap ||
      next.method !== first.method ||
      JSON.stringify(next.args ?? {}) !== JSON.stringify(first.args ?? {})
    ) {
      break
    }
    ids.push(...stepDeviceIds(next))
    length += 1
  }
  return {
    wire: {
      deviceId: ids.length === 0 ? 0 : ids.length === 1 ? ids[0]! : [...ids],
      cap: first.cap,
      method: first.method,
      ...(first.args !== undefined ? { args: { ...first.args } } : {}),
    },
    length,
  }
}

/**
 * Collapse consecutive same-action do bindings into one CapDoWire for editing.
 * Returns how many bindings were consumed (at least 1).
 */
export function collapseDoGroup(
  bindings: readonly NcActionBinding[],
  start: number,
): { readonly wire: CapDoWire; readonly length: number } {
  const first = bindings[start]
  if (first === undefined || first.kind !== 'do') {
    return {
      wire: { deviceId: 0, cap: '', method: '' },
      length: 1,
    }
  }
  const group = collapseCapGroup(
    bindings.slice(start).map((b) => (b.kind === 'do' ? b.action : { kind: 'wait', seconds: 0 })),
    0,
  )
  return group
}

export function NotificationRuleActions({
  value,
  onChange,
  devices,
  devicesState,
  sequences = [],
  showProblems = true,
}: NotificationRuleActionsProps) {
  const { t } = useTranslation()
  const knownIds = new Set(sequences.map((s) => s.id))
  const problems = validateRuleActions(value, knownIds)

  const setHook = (key: NcHookKey, next: readonly NcActionBinding[]): void =>
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

      {NC_HOOK_KEYS.map((key) => (
        <HookSection
          key={key}
          hookKey={key}
          bindings={value[key]}
          sequences={sequences}
          devices={devices}
          devicesState={devicesState}
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
            'system.notificationRuleActions.eachButtonRunsOneShared',
            'Each button runs one shared sequence when tapped.',
          )}
        >
          <Button
            size="sm"
            variant="ghost"
            type="button"
            disabled={sequences.length === 0}
            onClick={() =>
              onChange({
                ...value,
                buttons: [
                  ...value.buttons,
                  newButton(value.buttons.length, sequences[0]?.id ?? ''),
                ],
              })
            }
          >
            <Plus className="h-3.5 w-3.5 shrink-0" /> {t('system.notificationRuleActions.button')}
          </Button>
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

        {sequences.length === 0 ? (
          <p className="rounded border border-border px-3 py-2 text-[11px] text-foreground-subtle">
            {t(
              'system.notificationRuleActions.createASequenceOnThe',
              'Create a sequence on the Sequences tab first — a button runs one, it does not define its own steps.',
            )}
          </p>
        ) : value.buttons.length === 0 ? (
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
              sequences={sequences}
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
  bindings,
  sequences,
  devices,
  devicesState,
  onChange,
}: {
  readonly hookKey: NcHookKey
  readonly bindings: readonly NcActionBinding[]
  readonly sequences: readonly NcSharedSequence[]
  readonly devices: readonly RuleActionDevice[]
  readonly devicesState: DeviceListState
  readonly onChange: (next: readonly NcActionBinding[]) => void
}) {
  const { t } = useTranslation()
  const meta = NC_HOOK_LABELS[hookKey]

  const cards: {
    readonly start: number
    readonly kind: 'sequence' | 'do'
    readonly length: number
  }[] = []
  let i = 0
  while (i < bindings.length) {
    const b = bindings[i]!
    if (b.kind === 'sequence') {
      cards.push({ start: i, kind: 'sequence', length: 1 })
      i += 1
      continue
    }
    const group = collapseDoGroup(bindings, i)
    cards.push({ start: i, kind: 'do', length: group.length })
    i += group.length
  }

  return (
    <section className="space-y-2">
      <SectionHeader title={meta.title} description={meta.hint}>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={bindings.length >= 4 || sequences.length === 0}
          onClick={() => onChange([...bindings, newSequenceBinding(sequences[0]?.id ?? '')])}
        >
          <Plus className="h-3.5 w-3.5" /> {t('system.notificationRuleActions.sequence')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={bindings.length >= 4}
          onClick={() => onChange([...bindings, newDoBinding()])}
        >
          <Plus className="h-3.5 w-3.5" /> {t('system.notificationRuleActions.singleAction')}
        </Button>
      </SectionHeader>
      {bindings.length === 0 ? (
        <p className="rounded border border-border px-3 py-2 text-[11px] text-foreground-subtle">
          {t('system.notificationRuleActions.nothingOnThisEdge', 'Nothing on this edge.')}
        </p>
      ) : (
        cards.map((card) => {
          if (card.kind === 'sequence') {
            const binding = bindings[card.start]!
            if (binding.kind !== 'sequence') return null
            return (
              <div
                key={`seq-${String(card.start)}`}
                className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3"
              >
                <div className="min-w-0 flex-1">
                  <label className={LABEL}>
                    {t('system.notificationRuleActions.sequence', 'Sequence')}
                  </label>
                  <Select
                    wrapperClassName="inline-block w-auto"
                    className={FIELD}
                    value={binding.sequenceId}
                    onChange={(e) => {
                      const next = [...bindings]
                      next[card.start] = { kind: 'sequence', sequenceId: e.target.value }
                      onChange(next)
                    }}
                  >
                    {sequences.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => onChange(bindings.filter((_, idx) => idx !== card.start))}
                  title={t('common.remove', 'Remove')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )
          }

          const group = collapseDoGroup(bindings, card.start)
          return (
            <div
              key={`do-${String(card.start)}`}
              className="space-y-2 rounded-md border border-border p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <DeviceDoActionFields
                    value={group.wire}
                    devices={devices}
                    listState={devicesState}
                    allowMultiSameFamily
                    onChange={(wire) => {
                      const expanded = expandDoBindings(wire)
                      onChange([
                        ...bindings.slice(0, card.start),
                        ...expanded,
                        ...bindings.slice(card.start + card.length),
                      ])
                    }}
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() =>
                    onChange([
                      ...bindings.slice(0, card.start),
                      ...bindings.slice(card.start + card.length),
                    ])
                  }
                  title={t('common.remove', 'Remove')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )
        })
      )}
    </section>
  )
}

function ButtonRow({
  button,
  sequences,
  onChange,
  onRemove,
}: {
  readonly button: NcRuleNotificationButton
  readonly sequences: readonly NcSharedSequence[]
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
        <label className={LABEL}>{t('system.notificationRuleActions.sequence', 'Sequence')}</label>
        <Select
          wrapperClassName="inline-block w-auto"
          className={FIELD}
          value={button.sequenceId}
          onChange={(e) => onChange({ ...button, sequenceId: e.target.value })}
        >
          {sequences.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-32">
        <label className={LABEL}>{t('system.notificationRuleActions.icon', 'Icon')}</label>
        <Select
          wrapperClassName="inline-block w-auto"
          className={FIELD}
          value={button.icon ?? ''}
          onChange={(e) => {
            const next = { ...button }
            if (e.target.value === '') delete (next as { icon?: string }).icon
            else next.icon = e.target.value as typeof button.icon
            onChange(next)
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
