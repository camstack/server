/**
 * Column builders for event-driven NcRules (detection, sensor, sound, …, system).
 *
 * Extracted from `NotificationRules.tsx` so the unified Rules table can reuse
 * the same name / targets / last-run / snooze / actions cells without a module
 * cycle back through the page.
 */

import type { NcRule, NcSnooze } from '@camstack/types'
import { ruleKindOf, ruleKindSpec } from '@camstack/types'
import type { DataColumn } from '@camstack/ui-library'
import { Badge, Button, Switch } from '@camstack/ui-library'
import { Copy, FlaskConical } from 'lucide-react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { RuleHistoryButton, RuleLastRunCellView } from './NotificationRuleLastRun'
import { NotificationRuleSnoozeSwitch } from './NotificationRuleSnoozeSwitch'
import { NotificationRuleTestButton } from './NotificationRuleTestButton'
import { NcListDeleteButton, NcListNameCell, NcListRowControls } from './notification-list-chrome'
import type { RuleLastRunCell } from './notification-rule-last-run'
import {
  cooldownLabel,
  formStepsForSnooze,
  isRecognisedDelivery,
  isRuleEditable,
  isRuleSnoozeExempt,
  NC_GROUPED_CHOICE_LABEL,
  ruleDeliveryLabel,
} from './notification-rules.helpers'
import { summariseSystemEventKinds, summariseSystemEventScope } from './notification-system-events'
import i18n from '../../i18n/index'

export interface RuleColumnsDeps {
  readonly targetNameById: ReadonlyMap<string, string>
  /** Every snooze window the caller can see — the Snooze column reads it. */
  readonly snoozes: readonly NcSnooze[]
  /** Shared sequences — snooze exemption resolves sequence-ref actuation. */
  readonly sequences: readonly import('@camstack/types').NcSharedSequence[]
  readonly deletePending: boolean
  readonly onToggle: (rule: NcRule, enabled: boolean) => void
  readonly onDuplicate: (rule: NcRule) => void
  /** Open the rule in the editor — the row's click, and the name's keyboard path. */
  readonly onOpen: (rule: NcRule) => void
  /** The page's translator — column headers are not components and cannot use the hook. */
  readonly t: TFunction
  readonly onConfirmDelete: (rule: NcRule) => void
  /** Absent when the page is rendered without a simulate tab to hand off to. */
  readonly onTest?: (rule: NcRule) => void
  /** What the "Last run" cell of a rule may claim (D315 — decided once). */
  readonly lastRunOf: (ruleId: string) => RuleLastRunCell
  /** Absent when there is no History tab to hand off to. */
  readonly onOpenHistory?: (rule: NcRule) => void
}

/** A translated sentence with the rule's name filled in, initialised or not. */
function withName(template: string, name: string): string {
  return template.replaceAll('{{name}}', name)
}

/** Columns for the rules table — one row per rule, actions in the last column. */
export function ruleColumns(deps: RuleColumnsDeps): readonly DataColumn<NcRule>[] {
  return [
    {
      key: 'name',
      header: i18n.t('system.notificationRuleColumns.rule', 'Rule'),
      render: (rule) => (
        <NcListNameCell
          name={rule.name}
          enabled={rule.enabled}
          {...(isRuleEditable(rule) ? { onOpen: () => deps.onOpen(rule) } : {})}
        />
      ),
    },
    {
      key: 'trigger',
      header: i18n.t('system.notificationRuleColumns.trigger', 'Trigger'),
      nowrap: true,
      render: (rule) => (
        <span className="flex items-center gap-1.5">
          <span className="text-[11px] text-foreground-subtle">
            {ruleDeliveryLabel(
              rule,
              deps.t('notificationRules.grouping.choice', NC_GROUPED_CHOICE_LABEL),
            )}
          </span>
          {/* A trigger this build cannot author is SAID so in the list, not
              only in the dialog: the operator has to know before clicking that
              editing is limited, and `deliveryLabel` alone falls back to the
              raw enum string, which reads like a typo rather than a version
              gap. */}
          {!isRecognisedDelivery(rule.delivery) && (
            <Badge variant="warning">{i18n.t('common.readOnly')}</Badge>
          )}
        </span>
      ),
    },
    {
      key: 'targets',
      header: i18n.t('system.notificationRuleColumns.targets', 'Targets'),
      render: (rule) => {
        const first = rule.targets[0]
        const name = first ? (deps.targetNameById.get(first.targetId) ?? first.targetId) : null
        return (
          <span className="text-[11px] text-foreground-subtle">
            {rule.targets.length === 1 && name
              ? name
              : i18n.t('common.targetCount', { count: rule.targets.length })}
          </span>
        )
      },
    },
    {
      key: 'lastRun',
      header: i18n.t('system.notificationRuleColumns.lastRun', 'Last run'),
      nowrap: true,
      render: (rule) => <RuleLastRunCellView cell={deps.lastRunOf(rule.id)} />,
    },
    {
      key: 'priority',
      header: i18n.t('system.notificationRuleColumns.priority', 'Priority'),
      align: 'center',
      nowrap: true,
      render: (rule) => <span className="text-[11px] text-foreground-subtle">{rule.priority}</span>,
    },
    {
      // SNOOZE (R3): a switch on a rule a window can silence; an EMPTY cell on
      // one it cannot (it concerns or arms the alarm — derived, never stored,
      // D133). The cell says nothing more: no badge, no sentence.
      key: 'snooze',
      header: deps.t('notificationRules.columns.snooze', 'Snooze'),
      align: 'center',
      nowrap: true,
      render: (rule) => (
        <NcListRowControls>
          <NotificationRuleSnoozeSwitch
            rule={rule}
            snoozes={deps.snoozes}
            exempt={isRuleSnoozeExempt(
              rule.conditions,
              formStepsForSnooze(
                {
                  onActivation: rule.actions?.onActivation ?? [],
                  onDeactivation: rule.actions?.onDeactivation ?? [],
                  onTrigger: rule.actions?.onTrigger ?? [],
                  onTriggerOff: rule.actions?.onTriggerOff ?? [],
                  buttons: rule.actions?.buttons ?? [],
                },
                deps.sequences,
              ),
            )}
          />
        </NcListRowControls>
      ),
    },
    {
      key: 'enabled',
      header: i18n.t('system.notificationRuleColumns.on', 'On'),
      align: 'center',
      nowrap: true,
      render: (rule) => (
        <NcListRowControls>
          <Switch
            checked={rule.enabled}
            onCheckedChange={(next) => deps.onToggle(rule, next)}
            aria-label={i18n.t('system.notificationRuleColumns.toggle', 'toggle {{name}}', {
              name: rule.name,
            })}
          />
        </NcListRowControls>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      nowrap: true,
      render: (rule) =>
        isRuleEditable(rule) ? (
          <NcListRowControls className="flex items-center justify-end gap-1">
            {/* TEST NOW — fires the rule and really sends the notification. The
              plan is the server's (`nc.testRule`), so a row needs to know
              nothing about what a sound rule or a system rule requires. */}
            <NotificationRuleTestButton
              ruleId={rule.id}
              ruleName={rule.name}
              {...(rule.conditions.devices?.[0] !== undefined
                ? { fallbackDeviceId: rule.conditions.devices[0] }
                : {})}
            />
            {deps.onOpenHistory && (
              <RuleHistoryButton rule={rule} onOpenHistory={deps.onOpenHistory} />
            )}
            {deps.onTest && (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => deps.onTest?.(rule)}
                title={i18n.t(
                  'system.notificationRuleColumns.openInTheSimulatorDescribe',
                  'Open in the simulator — describe an event and tune it before injecting',
                )}
                aria-label={i18n.t('system.notificationRuleColumns.simulate', 'simulate {{name}}', {
                  name: rule.name,
                })}
              >
                <FlaskConical className="h-3.5 w-3.5" />
              </Button>
            )}
            {/* No Edit button: the row IS the edit target (R2). The snooze has
              its own column. */}
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => deps.onDuplicate(rule)}
              title={i18n.t('system.notificationRuleColumns.duplicate', 'Duplicate')}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <RuleDeleteButton rule={rule} deps={deps} />
          </NcListRowControls>
        ) : (
          <ReadOnlyRuleActions rule={rule} deps={deps} />
        ),
    },
  ]
}

/**
 * The actions of a rule that can be read but not edited — a `mixed` system
 * rule (D637). Delete and History only (the enable switch has its own column):
 * no Edit, no Duplicate, no Test, no Simulate. Its deliveries are still real.
 * The badge says what to do instead, with the kind's own explanation on hover.
 */
function ReadOnlyRuleActions({ rule, deps }: ReadOnlyRuleActionsProps) {
  const { t } = useTranslation()
  return (
    <NcListRowControls className="flex items-center justify-end gap-1">
      <span title={ruleKindSpec(ruleKindOf(rule)).blurb}>
        <Badge variant="warning">
          {t(
            'system.notificationRuleColumns.recreateAsOneRulePer',
            'Recreate as one rule per family',
          )}
        </Badge>
      </span>
      {deps.onOpenHistory && <RuleHistoryButton rule={rule} onOpenHistory={deps.onOpenHistory} />}
      <RuleDeleteButton rule={rule} deps={deps} />
    </NcListRowControls>
  )
}

interface ReadOnlyRuleActionsProps {
  readonly rule: NcRule
  readonly deps: RuleColumnsDeps
}

/**
 * Delete, confirmed through the shared centered confirm dialog — the SAME
 * control Summaries / Timelapses and `DeviceDeleteAction` use (R4).
 */
function RuleDeleteButton({ rule, deps }: ReadOnlyRuleActionsProps) {
  const { t } = useTranslation()
  return (
    <NcListDeleteButton
      pending={deps.deletePending}
      title={t('notificationRules.delete.confirm', 'Delete this rule?')}
      message={withName(
        t(
          'notificationRules.delete.message',
          'This will permanently delete "{{name}}". This action cannot be undone.',
        ),
        rule.name,
      )}
      confirmLabel={t('common.delete', 'Delete')}
      cancelLabel={t('common.cancel', 'Cancel')}
      ariaLabel={withName(t('notificationRules.delete.aria', 'delete {{name}}'), rule.name)}
      onConfirm={() => deps.onConfirmDelete(rule)}
    />
  )
}

/**
 * Columns for the SYSTEM EVENTS section.
 *
 * Same actions, different questions. A system rule has no priority worth
 * scanning and no trigger worth repeating; what an operator checks is which
 * events it watches, how narrowly, and how often it is allowed to repeat —
 * the cooldown is the reason a flapping camera does or does not spam a phone.
 */
export function systemRuleColumns(deps: RuleColumnsDeps): readonly DataColumn<NcRule>[] {
  // Reused verbatim from the detection columns — the name cell, the enabled
  // switch and the row actions are the SAME control, and a second copy is how
  // the two tables start behaving differently.
  const shared = ruleColumns(deps)
  const pick = (key: string): readonly DataColumn<NcRule>[] => shared.filter((c) => c.key === key)
  return [
    ...pick('name'),
    {
      key: 'events',
      header: i18n.t('system.notificationRuleColumns.events', 'Events'),
      render: (rule) => (
        <span className="text-[11px] text-foreground-subtle">
          {summariseSystemEventKinds(rule.conditions.systemEvent?.kinds)}
        </span>
      ),
    },
    {
      key: 'scope',
      header: i18n.t('system.notificationRuleColumns.scope', 'Scope'),
      nowrap: true,
      render: (rule) => (
        <span className="text-[11px] text-foreground-subtle">
          {summariseSystemEventScope(rule.conditions.systemEvent)}
        </span>
      ),
    },
    {
      key: 'targets',
      header: i18n.t('system.notificationRuleColumns.targets', 'Targets'),
      render: (rule) => {
        const first = rule.targets[0]
        const name = first ? (deps.targetNameById.get(first.targetId) ?? first.targetId) : null
        return (
          <span className="text-[11px] text-foreground-subtle">
            {rule.targets.length === 1 && name
              ? name
              : i18n.t('common.targetCount', { count: rule.targets.length })}
          </span>
        )
      },
    },
    {
      key: 'cooldown',
      header: i18n.t('system.notificationRuleColumns.cooldown', 'Cooldown'),
      nowrap: true,
      render: (rule) => (
        <span className="text-[11px] text-foreground-subtle">
          {cooldownLabel(rule.throttle.cooldownSec)}
        </span>
      ),
    },
    ...pick('lastRun'),
    ...pick('snooze'),
    ...pick('enabled'),
    ...pick('actions'),
  ]
}
