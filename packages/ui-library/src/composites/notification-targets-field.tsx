/**
 * Shared notification-output target pickers.
 *
 * The Notification Center editors (Summaries, Timelapses, Rules, Calendar
 * events) and ConfigUISchema forms (script settings, addon settings) all
 * pick the same catalog — `notificationOutput.listTargets`. One presentational
 * control plus two ConfigUISchema wrappers so a script can declare
 * `notification-target-select` / `notification-target-multiselect` without
 * inventing a parallel picker.
 *
 * A DISABLED target is offered and marked, never hidden: it is a legitimate
 * choice (the operator re-enables it later), and hiding it would make a rule
 * whose only target is off look like a rule with no target at all.
 *
 * Single and multi both render through `OptionSelect` (dropdown + pills,
 * searchable, kind brand icons via `iconUrl`).
 */

import { useMemo, type ReactNode, type JSX } from 'react'
import type {
  ConfigNotificationTargetMultiSelectField,
  ConfigNotificationTargetSelectField,
} from '@camstack/types'
import {
  useNotificationOutputListTargetKinds,
  useNotificationOutputListTargets,
} from '../generated/system-hooks'
import type { TranslationFn } from './config-form-builder'
import { useUiText } from '../contexts/ui-text'
import { resolveLabel } from './config-form-builder'
import { OptionSelect } from './option-select/OptionSelect'
import {
  buildKindIconMap,
  targetsToOptions,
  toTargetOptions,
  type NotificationTargetOption,
} from './notification-targets-options'

export type { NotificationTargetOption } from './notification-targets-options'

export interface NotificationTargetsFieldProps {
  readonly targets: readonly NotificationTargetOption[]
  readonly value: readonly string[]
  readonly onChange: (next: string[]) => void
  readonly disabled?: boolean
  /** Cap on how many targets may be selected. */
  readonly maxItems?: number
  /** Per-target test id is `<prefix>-<id>`. Default `notification-target`. */
  readonly testIdPrefix?: string
  /** What an empty catalog says. */
  readonly emptyMessage?: string
  /** Target ids that carry an extra note badge (e.g. already covered by a rule). */
  readonly noteIds?: ReadonlySet<string>
  /** Label on the note badge. Default `note`. */
  readonly noteLabel?: string
  readonly label?: string
  readonly description?: string
  /** Kind brand icons keyed as `addonId:kind`. */
  readonly kindIconUrls?: ReadonlyMap<string, string>
}

export interface NotificationTargetSelectFieldProps {
  readonly targets: readonly NotificationTargetOption[]
  readonly value: string
  readonly onChange: (next: string) => void
  readonly disabled?: boolean
  readonly emptyMessage?: string
  readonly placeholder?: string
  readonly testId?: string
  readonly label?: string
  readonly description?: string
  readonly kindIconUrls?: ReadonlyMap<string, string>
}

/**
 * Multi-select of delivery targets (NC Summaries / Timelapses / Rules shape).
 */
export function NotificationTargetsField({
  targets,
  value,
  onChange,
  disabled = false,
  maxItems,
  testIdPrefix = 'notification-target',
  emptyMessage: emptyMessageProp,
  noteIds,
  noteLabel: noteLabelProp,
  label,
  description,
  kindIconUrls: kindIconUrlsProp,
}: NotificationTargetsFieldProps): JSX.Element {
  const t = useUiText()
  const kindsQuery = useNotificationOutputListTargetKinds({})
  const kindIconUrlsFromQuery = useMemo(() => buildKindIconMap(kindsQuery.data), [kindsQuery.data])
  const kindIconUrls = kindIconUrlsProp ?? kindIconUrlsFromQuery
  const emptyMessage =
    emptyMessageProp ??
    t(
      'uiLibrary.notificationTargetsField.defaultEmpty',
      'No delivery target is configured. Add one on the Targets tab first — without one the notification is rendered and thrown away.',
    )
  const noteLabel = noteLabelProp ?? t('uiLibrary.notificationTargetsField.note', 'note')

  const options = useMemo(
    () => targetsToOptions(targets, kindIconUrls, noteIds, noteLabel),
    [targets, kindIconUrls, noteIds, noteLabel],
  )

  return (
    <OptionSelect
      mode="multi"
      options={options}
      value={value}
      onChange={onChange}
      disabled={disabled}
      searchable
      creatable={false}
      {...(maxItems !== undefined ? { maxItems } : {})}
      emptyMessage={emptyMessage}
      placeholder={t('uiLibrary.notificationTargetsField.searchTargets', 'Search targets…')}
      label={label}
      description={description}
      testId={`${testIdPrefix}s`}
      optionTestIdPrefix={testIdPrefix}
      listboxId={`${testIdPrefix}-listbox`}
    />
  )
}

/**
 * Single-select of one delivery target (Calendar events / script settings).
 */
export function NotificationTargetSelectField({
  targets,
  value,
  onChange,
  disabled = false,
  emptyMessage: emptyMessageProp,
  placeholder: placeholderProp,
  testId = 'notification-target-select',
  label,
  description,
  kindIconUrls: kindIconUrlsProp,
}: NotificationTargetSelectFieldProps): JSX.Element {
  const t = useUiText()
  const kindsQuery = useNotificationOutputListTargetKinds({})
  const kindIconUrlsFromQuery = useMemo(() => buildKindIconMap(kindsQuery.data), [kindsQuery.data])
  const kindIconUrls = kindIconUrlsProp ?? kindIconUrlsFromQuery

  const emptyMessage =
    emptyMessageProp ??
    t(
      'uiLibrary.notificationTargetsField.defaultEmpty',
      'No delivery target is configured. Add one on the Targets tab first — without one the notification is rendered and thrown away.',
    )
  const placeholder = placeholderProp ?? t('uiLibrary.notificationTargetsField.select', 'Select…')
  const noteLabel = t('uiLibrary.notificationTargetsField.note', 'note')

  const options = useMemo(
    () => targetsToOptions(targets, kindIconUrls, undefined, noteLabel),
    [targets, kindIconUrls, noteLabel],
  )

  return (
    <OptionSelect
      mode="single"
      options={options}
      value={value}
      onChange={onChange}
      disabled={disabled}
      searchable
      creatable={false}
      emptyMessage={emptyMessage}
      placeholder={placeholder}
      label={label}
      description={description}
      testId={testId}
      optionTestIdPrefix={testId}
      listboxId={`${testId}-listbox`}
    />
  )
}

function FieldShell({
  label,
  description,
  required,
  translationFn,
  children,
}: {
  readonly label: string
  readonly description?: string
  readonly required?: boolean
  readonly translationFn?: TranslationFn
  readonly children: ReactNode
}) {
  return (
    <div className="space-y-1">
      <label className="block text-[11px] font-medium text-foreground mb-1 break-words">
        {resolveLabel(label, translationFn)}
        {required === true ? <span className="text-danger"> *</span> : null}
      </label>
      {children}
      {description !== undefined && (
        <p className="text-[10px] text-foreground-subtle mt-0.5 break-words">
          {resolveLabel(description, translationFn)}
        </p>
      )}
    </div>
  )
}

/**
 * ConfigUISchema `notification-target-multiselect` — fetches listTargets and
 * stores a `string[]` of target ids.
 */
export function ConfigNotificationTargetMultiSelectFieldView({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  readonly field: ConfigNotificationTargetMultiSelectField
  readonly value: unknown
  readonly onChange: (v: unknown) => void
  readonly disabled?: boolean
  readonly translationFn?: TranslationFn
}): JSX.Element {
  const t = useUiText()
  const targetsQuery = useNotificationOutputListTargets({})
  const kindsQuery = useNotificationOutputListTargetKinds({})
  const targets = useMemo(() => toTargetOptions(targetsQuery.data), [targetsQuery.data])
  const kindIconUrls = useMemo(() => buildKindIconMap(kindsQuery.data), [kindsQuery.data])

  const selected = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string' && value.length > 0
      ? value.includes(',')
        ? value
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
        : [value]
      : []

  const pending = targetsQuery.isPending || kindsQuery.isPending
  const error = targetsQuery.isError
    ? targetsQuery.error
    : kindsQuery.isError
      ? kindsQuery.error
      : null

  if (pending) {
    return (
      <FieldShell
        label={field.label}
        description={field.description}
        required={field.required}
        translationFn={translationFn}
      >
        <p className="text-[11px] text-foreground-subtle">
          {t('uiLibrary.notificationTargetsField.loading', 'Loading targets…')}
        </p>
      </FieldShell>
    )
  }

  if (error !== null) {
    return (
      <FieldShell
        label={field.label}
        description={field.description}
        required={field.required}
        translationFn={translationFn}
      >
        <p className="text-[11px] text-danger">
          {t(
            'uiLibrary.notificationTargetsField.loadError',
            'Could not load targets: {{message}}',
            {
              message: error instanceof Error ? error.message : String(error),
            },
          )}
        </p>
      </FieldShell>
    )
  }

  return (
    <NotificationTargetsField
      targets={targets}
      value={selected}
      onChange={(next) => onChange(next)}
      disabled={disabled === true || field.disabled === true}
      {...(field.maxItems !== undefined ? { maxItems: field.maxItems } : {})}
      kindIconUrls={kindIconUrls}
      label={resolveLabel(field.label, translationFn)}
      description={
        field.description !== undefined ? resolveLabel(field.description, translationFn) : undefined
      }
      emptyMessage={t(
        'uiLibrary.notificationTargetsField.noneConfigured',
        'No delivery target is configured. Add one under Notification Center → Targets first.',
      )}
      testIdPrefix={`config-target-${field.key}`}
    />
  )
}

/**
 * ConfigUISchema `notification-target-select` — fetches listTargets and stores
 * one target id string.
 */
export function ConfigNotificationTargetSelectFieldView({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  readonly field: ConfigNotificationTargetSelectField
  readonly value: unknown
  readonly onChange: (v: unknown) => void
  readonly disabled?: boolean
  readonly translationFn?: TranslationFn
}): JSX.Element {
  const t = useUiText()
  const targetsQuery = useNotificationOutputListTargets({})
  const kindsQuery = useNotificationOutputListTargetKinds({})
  const targets = useMemo(() => toTargetOptions(targetsQuery.data), [targetsQuery.data])
  const kindIconUrls = useMemo(() => buildKindIconMap(kindsQuery.data), [kindsQuery.data])

  const current = typeof value === 'string' ? value : ''

  const pending = targetsQuery.isPending || kindsQuery.isPending
  const error = targetsQuery.isError
    ? targetsQuery.error
    : kindsQuery.isError
      ? kindsQuery.error
      : null

  if (pending) {
    return (
      <FieldShell
        label={field.label}
        description={field.description}
        required={field.required}
        translationFn={translationFn}
      >
        <p className="text-[11px] text-foreground-subtle">
          {t('uiLibrary.notificationTargetsField.loading', 'Loading targets…')}
        </p>
      </FieldShell>
    )
  }

  if (error !== null) {
    return (
      <FieldShell
        label={field.label}
        description={field.description}
        required={field.required}
        translationFn={translationFn}
      >
        <p className="text-[11px] text-danger">
          {t(
            'uiLibrary.notificationTargetsField.loadError',
            'Could not load targets: {{message}}',
            {
              message: error instanceof Error ? error.message : String(error),
            },
          )}
        </p>
      </FieldShell>
    )
  }

  return (
    <NotificationTargetSelectField
      targets={targets}
      value={current}
      onChange={(next) => onChange(next)}
      disabled={disabled === true || field.disabled === true}
      kindIconUrls={kindIconUrls}
      label={resolveLabel(field.label, translationFn)}
      description={
        field.description !== undefined ? resolveLabel(field.description, translationFn) : undefined
      }
      emptyMessage={t(
        'uiLibrary.notificationTargetsField.noneConfigured',
        'No delivery target is configured. Add one under Notification Center → Targets first.',
      )}
      testId={`config-target-${field.key}`}
    />
  )
}
