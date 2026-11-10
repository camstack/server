/**
 * Each selected target of a rule, expandable to its OWN settings (#487): the
 * texts its notifier delivers, its priority, its schedule and the delivery
 * parameters its notifier declares (D938). Absent = the rule's value: the
 * rule-level texts and priority are the defaults every target inherits.
 *
 * What a panel offers is the target's declaration (#483, `deliverableFields`):
 * a speaker that says only a title gets a title field and nothing else of the
 * message. A target whose kind the catalog did not describe is offered every
 * field — not-yet-known never reads as not-supported (D315).
 */
import type {
  DeliveryParamValue,
  NcSchedule,
  NcTargetOverride,
  NcTargetOverrides,
  NcTemplateVarDescriptor,
  NotificationField,
  NotificationFieldSupport,
  Target,
} from '@camstack/types'
import { CollapsibleCard, FormField, Select } from '@camstack/ui-library'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TemplateField } from '../../components/notifications/TemplateField'
import { ScheduleField } from './notification-schedule-field'
import { ParamControl } from './NotificationRuleDeliveryOptions'
import { declaredBy, type DeliveryKindRef } from './rule-form-delivery'
import { NC_PRIORITY_OPTIONS } from './rule-form-parsers'
import type { NcTargetParamsMap } from './rule-form-state'
import { targetFieldsOf, writeTargetOverride, writeTargetParam } from './rule-form-target-settings'

export interface NotificationRuleTargetSettingsProps {
  readonly targetIds: readonly string[]
  readonly targets: readonly Target[]
  readonly kinds: readonly DeliveryKindRef[]
  readonly overrides: NcTargetOverrides
  readonly targetParams: NcTargetParamsMap
  /** The rule's own priority — what a target without an override inherits. */
  readonly rulePriority: number
  readonly onOverridesChange: (next: NcTargetOverrides) => void
  readonly onTargetParamsChange: (next: NcTargetParamsMap) => void
  readonly varsFor: (slot: 'title' | 'body') => readonly NcTemplateVarDescriptor[] | undefined
}

export function NotificationRuleTargetSettings(props: NotificationRuleTargetSettingsProps) {
  const { t } = useTranslation()
  // A target that already differs from the rule opens expanded: what is
  // customised is visible without a click.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(props.targetIds.filter((id) => props.overrides[id] !== undefined)),
  )
  if (props.targetIds.length === 0) return null
  const fieldsOf = targetFieldsOf(props.targets, props.kinds)
  const toggle = (id: string, open: boolean): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  return (
    <div className="flex flex-col gap-2" data-testid="rule-target-settings">
      <p className="text-sm font-medium text-foreground">
        {t('system.notificationRules.targetSettings.title', 'Per-target settings')}
      </p>
      <p className="text-[10px] text-foreground-subtle">
        {t(
          'system.notificationRules.targetSettings.help',
          'Each target follows the rule unless you change it here. A target offers only what its notifier can deliver.',
        )}
      </p>
      {props.targetIds.map((id) => (
        <TargetPanel
          key={id}
          {...props}
          targetId={id}
          name={props.targets.find((target) => target.id === id)?.name ?? id}
          fields={fieldsOf(id)}
          expanded={expanded.has(id)}
          onExpandedChange={(open) => toggle(id, open)}
        />
      ))}
    </div>
  )
}

interface TargetPanelProps extends NotificationRuleTargetSettingsProps {
  readonly targetId: string
  readonly name: string
  readonly fields: readonly NotificationField[] | undefined
  readonly expanded: boolean
  readonly onExpandedChange: (next: boolean) => void
}

function TargetPanel(props: TargetPanelProps) {
  const { t } = useTranslation()
  const { targetId, fields } = props
  const own: NcTargetOverride = props.overrides[targetId] ?? {}
  const has = (field: NotificationField): boolean => fields === undefined || fields.includes(field)
  const params = declaredBy(targetId, props.targets, props.kinds)
  const customised = Object.keys(own).length > 0 || props.targetParams[targetId] !== undefined
  const write = (next: NcTargetOverride): void =>
    props.onOverridesChange(
      writeTargetOverride(
        props.overrides,
        targetId,
        Object.keys(next).length > 0 ? next : undefined,
      ),
    )
  const writeText = (slot: 'title' | 'body', value: string): void => {
    const { [slot]: _previous, ...rest } = own.template ?? {}
    const template = value === '' ? rest : { ...rest, [slot]: value }
    const { template: _old, ...others } = own
    write(Object.keys(template).length > 0 ? { ...others, template } : others)
  }
  const writePriority = (raw: string): void => {
    const { priority: _old, ...others } = own
    write(raw === '' ? others : { ...others, priority: Number(raw) })
  }
  const writeSchedule = (schedule: NcSchedule | undefined): void => {
    const { schedule: _old, ...others } = own
    write(schedule === undefined ? others : { ...others, schedule })
  }
  const inherited = NC_PRIORITY_OPTIONS.find((o) => o.value === props.rulePriority)?.label
  return (
    <CollapsibleCard
      expanded={props.expanded}
      onExpandedChange={props.onExpandedChange}
      header={
        <span
          className="flex items-center gap-2 text-xs"
          data-testid={`rule-target-settings-${targetId}`}
        >
          <span className="font-medium text-foreground">{props.name}</span>
          <span className="text-foreground-subtle">
            {customised
              ? t('system.notificationRules.targetSettings.customised', 'Own settings')
              : t('system.notificationRules.targetSettings.followsRule', 'Follows the rule')}
          </span>
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {has('title') && (
          <TemplateField
            label={t(
              'system.notificationRules.targetSettings.titleOverride',
              'Title for this target',
            )}
            value={own.template?.title ?? ''}
            onChange={(next) => writeText('title', next)}
            vars={props.varsFor('title')}
            placeholder={t(
              'system.notificationRules.targetSettings.useRuleText',
              "The rule's text",
            )}
            testId={`rule-target-${targetId}-title`}
          />
        )}
        {has('body') && (
          <TemplateField
            label={t(
              'system.notificationRules.targetSettings.bodyOverride',
              'Body for this target',
            )}
            value={own.template?.body ?? ''}
            onChange={(next) => writeText('body', next)}
            vars={props.varsFor('body')}
            placeholder={t(
              'system.notificationRules.targetSettings.useRuleText',
              "The rule's text",
            )}
            multiline
            testId={`rule-target-${targetId}-body`}
          />
        )}
        {has('priority') && (
          <FormField label={t('system.notificationRules.priority', 'Priority')}>
            <Select
              value={own.priority === undefined ? '' : String(own.priority)}
              onChange={(event) => writePriority(event.target.value)}
              options={[
                {
                  value: '',
                  label: t('system.notificationRules.targetSettings.rulePriority', {
                    defaultValue: "The rule's priority ({{priority}})",
                    priority: inherited ?? String(props.rulePriority),
                  }),
                },
                ...NC_PRIORITY_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
              ]}
              data-testid={`rule-target-${targetId}-priority`}
            />
          </FormField>
        )}
        <FormField
          label={t(
            'system.notificationRules.targetSettings.schedule',
            'When this target is notified',
          )}
        >
          <ScheduleField
            value={own.schedule}
            onChange={writeSchedule}
            emptyHint={t(
              'system.notificationRules.targetSettings.scheduleEmpty',
              'Whenever the rule fires.',
            )}
          />
        </FormField>
        {params.map((param) => (
          <FormField key={param.key} label={param.label}>
            <ParamControl
              param={param}
              value={props.targetParams[targetId]?.[param.key]}
              onChange={(next: DeliveryParamValue | undefined) =>
                props.onTargetParamsChange(
                  writeTargetParam(props.targetParams, targetId, param.key, next),
                )
              }
            />
          </FormField>
        ))}
      </div>
    </CollapsibleCard>
  )
}

export interface FieldDropHintProps {
  readonly support: NotificationFieldSupport | undefined
}

/** Under a rule-level field: the selected targets that will not receive it. */
export function FieldDropHint({ support }: FieldDropHintProps) {
  const { t } = useTranslation()
  if (support === undefined || support.droppedBy.length === 0) return null
  return (
    <p
      className="text-[10px] text-foreground-subtle"
      data-testid={`rule-field-dropped-${support.field}`}
    >
      {t('system.notificationRules.targetSettings.droppedBy', {
        defaultValue: 'Not delivered to: {{targets}}',
        targets: support.droppedBy.join(', '),
      })}
    </p>
  )
}
