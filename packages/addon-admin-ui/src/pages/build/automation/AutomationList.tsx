/**
 * The list of automations — the same status discipline as Scripts, because they
 * are the same thing underneath.
 *
 * An automation IS a core block. So the rules that decide whether a row is green
 * are `core-block-status.ts`'s, unchanged: an ENABLED block that is not running
 * is an ERROR even when the stored status says `stopped`, broken rows sort
 * first, and the header counts the failures so one is read before any row is.
 * Re-deriving any of that here would produce a second opinion about the same
 * process.
 *
 * **"Run actions" is rendered and refused.** The authority that fires an
 * automation by hand — `automation-control.trigger` — is not wired yet, and this
 * surface does not get to invent a second way to execute one. The menu item is
 * present and honestly disabled; it never does anything else.
 */

import { type AutomationRecipe, type CoreBlock, coreBlockAddonId } from '@camstack/types'
import {
  Badge,
  Button,
  EmptyState,
  formatLastSeen,
  KebabMenu,
  LogStream,
  Skeleton,
  Switch,
  useCoreBlocksGetTraces,
  useUiText,
} from '@camstack/ui-library'
import { Pencil, Play, Plus, ScrollText, Trash2, Workflow } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { formatRelativeTime } from '../../../components/device/hero/format'
import { badgeVariantForTone, describeBlockStatus } from '../core-block-status'
import { triggerKindLabel } from './recipe-parts'

/** A last-run column asks once per visible row; slow enough that a page of rows is not a load. */
const LAST_RUN_POLL_MS = 30_000

export interface AutomationSummaryProps {
  readonly block: CoreBlock
  readonly logsOpen: boolean
  /** Set when the block's embedded recipe could not be read — the row is still
   *  shown, because hiding a stored automation is how one goes missing. */
  readonly unreadable: string | null
}

/** The name cell: name, status, last edit, and the logs panel when open. */
export function AutomationSummary({ block, logsOpen, unreadable }: AutomationSummaryProps) {
  const uiText = useUiText()
  const { t } = useTranslation()
  const status = describeBlockStatus(block)
  const edited = formatLastSeen(block.updatedAt, uiText)

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate font-medium">{block.name}</span>
        <Badge variant={badgeVariantForTone(status.tone)}>{status.label}</Badge>
        {edited !== null && (
          <span className="text-xs text-foreground-subtle">
            {t('common.edited', { when: edited })}
          </span>
        )}
      </div>
      {/* A healthy or switched-off automation needs no sentence; one that is
          not running always says why — an automation that is not running with
          no reason given is the failure this page exists to prevent. */}
      {(status.tone === 'error' || status.tone === 'pending') && (
        <p className="mt-0.5 text-xs text-foreground-subtle">{status.detail}</p>
      )}
      {unreadable !== null && (
        <p className="mt-0.5 text-xs text-warning">
          {t('automation.editor.listUnreadable', { reason: unreadable })}
        </p>
      )}
      {logsOpen && (
        <div className="mt-2 rounded border border-border">
          <div className="border-b border-border px-3 py-1.5 text-xs text-foreground-subtle">
            <Trans
              i18nKey="common.logsOf"
              values={{ id: coreBlockAddonId(block.id) }}
              components={{ code: <code /> }}
            />
          </div>
          <LogStream
            addonId={coreBlockAddonId(block.id)}
            maxHeight="max-h-64"
            showFilters={false}
          />
        </div>
      )}
    </div>
  )
}

const TRIGGER_SUMMARY_LIMIT = 2

/** What starts the automation: the distinct trigger kinds, in recipe order. */
export function triggerSummaryOf(recipe: AutomationRecipe): string {
  const labels = recipe.triggers.map((trigger) => triggerKindLabel(trigger.kind))
  const distinct = [...new Set(labels)]
  const shown = distinct.slice(0, TRIGGER_SUMMARY_LIMIT).join(', ')
  const rest = distinct.length - TRIGGER_SUMMARY_LIMIT
  return rest > 0 ? `${shown} +${rest}` : shown
}

export interface AutomationTriggerCellProps {
  /** Null when the embedded recipe could not be read. */
  readonly recipe: AutomationRecipe | null
}

export function AutomationTriggerCell({ recipe }: AutomationTriggerCellProps) {
  const { t } = useTranslation()
  if (recipe === null) return <span className="text-foreground-subtle">{'-'}</span>
  const summary = triggerSummaryOf(recipe)
  if (summary === '') {
    return (
      <span className="text-foreground-subtle">
        {t('automation.automationList.noTrigger', 'No trigger')}
      </span>
    )
  }
  return <span>{summary}</span>
}

/**
 * When the automation last RAN — a run that started the actions, not a skipped
 * evaluation. Unanswered, unknown and "never" are three different things.
 */
export function AutomationLastRunCell({ blockId }: { readonly blockId: string }) {
  const { t } = useTranslation()
  const traces = useCoreBlocksGetTraces({ blockId }, { refetchInterval: LAST_RUN_POLL_MS })
  if (traces.data === undefined) {
    return traces.error === null || traces.error === undefined ? (
      <Skeleton className="h-4 w-16" />
    ) : (
      <span className="text-foreground-subtle">
        {t('automation.automationList.lastRunUnknown', 'Unknown')}
      </span>
    )
  }
  const lastRun = traces.data.traces.findLast((trace) => !trace.outcome.startsWith('skipped-'))
  if (lastRun === undefined) {
    return (
      <span className="text-foreground-subtle">
        {t('automation.automationList.neverRan', 'Never ran')}
      </span>
    )
  }
  const failed = lastRun.outcome === 'failed' || lastRun.outcome === 'aborted'
  return (
    <span className="inline-flex items-center gap-2">
      {formatRelativeTime(lastRun.lastAt)}
      {failed && (
        <Badge variant="danger">{t('automation.automationList.lastRunFailed', 'Failed')}</Badge>
      )}
    </span>
  )
}

export interface AutomationEnabledSwitchProps {
  readonly block: CoreBlock
  readonly disabled: boolean
  readonly onToggle: (enabled: boolean) => void
}

/** Enable / disable in the row. The row opens the editor on click, so the
 *  switch keeps its own clicks to itself. */
export function AutomationEnabledSwitch({
  block,
  disabled,
  onToggle,
}: AutomationEnabledSwitchProps) {
  const { t } = useTranslation()
  return (
    <span
      className="inline-flex"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Switch
        checked={block.enabled}
        disabled={disabled}
        onCheckedChange={onToggle}
        aria-label={
          block.enabled
            ? t('automation.automationList.disableNamed', 'Disable {{name}}', {
                name: block.name,
              })
            : t('automation.automationList.enableNamed', 'Enable {{name}}', {
                name: block.name,
              })
        }
      />
    </span>
  )
}

export interface AutomationActionsProps {
  readonly unreadable: string | null
  readonly onEdit: () => void
  readonly onToggleLogs: () => void
  readonly onDelete: () => void
}

/** The row-actions menu. Its trigger swallows the row click. */
export function AutomationActions({
  unreadable,
  onEdit,
  onToggleLogs,
  onDelete,
}: AutomationActionsProps) {
  const { t } = useTranslation()
  return (
    <span
      className="inline-flex justify-end"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <KebabMenu
        items={[
          {
            id: 'edit',
            label: t('common.edit', 'Edit'),
            icon: Pencil,
            disabled: unreadable !== null,
            description:
              unreadable === null
                ? undefined
                : t(
                    'automation.automationList.thisBlockCannotBeOpened',
                    'This block cannot be opened visually',
                  ),
            onClick: onEdit,
          },
          {
            id: 'run',
            label: t('automation.automationList.runActions', 'Run actions'),
            icon: Play,
            disabled: true,
            description: t('automation.automationList.runNotAvailable', 'Not available yet'),
            onClick: () => undefined,
          },
          {
            id: 'logs',
            label: t('automation.automationList.logs', 'Logs'),
            icon: ScrollText,
            onClick: onToggleLogs,
          },
          {
            id: 'delete',
            label: t('common.delete', 'Delete'),
            icon: Trash2,
            danger: true,
            separatorBefore: true,
            onClick: onDelete,
          },
        ]}
      />
    </span>
  )
}

export interface AutomationEmptyStateProps {
  readonly onCreate: () => void
}

/** Says only what is true: there are none. */
export function AutomationEmptyState({ onCreate }: AutomationEmptyStateProps) {
  const { t } = useTranslation()
  return (
    <EmptyState
      icon={Workflow}
      title={t('automation.automationList.noAutomationsYet', 'No automations yet.')}
      action={
        <Button onClick={onCreate} data-testid="automation-empty-new">
          <Plus className="h-4 w-4" />{' '}
          {t('automation.automationList.newAutomation', 'New automation')}
        </Button>
      }
    />
  )
}
