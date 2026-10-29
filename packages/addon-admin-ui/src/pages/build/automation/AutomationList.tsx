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
 * surface does not get to invent a second way to execute one. A button that is
 * present and honestly disabled says the feature exists and is not ready; a
 * button that quietly did something else would be the worst outcome available.
 */

import { type CoreBlock, coreBlockAddonId } from '@camstack/types'
import {
  Badge,
  Button,
  Card,
  formatLastSeen,
  LogStream,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useUiText,
} from '@camstack/ui-library'
import { Pencil, Play, ScrollText, Trash2 } from 'lucide-react'
import { badgeVariantForTone, describeBlockStatus } from '../core-block-status'
import { Trans, useTranslation } from 'react-i18next'

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
      {/* Never conditional — `describeBlockStatus` guarantees a line for
          every state, and an automation that is not running with no reason
          given is the failure this page exists to prevent. */}
      <p className="mt-0.5 text-xs text-foreground-subtle">{status.detail}</p>
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

export interface AutomationActionsProps {
  readonly block: CoreBlock
  readonly busy: boolean
  readonly unreadable: string | null
  readonly onEdit: () => void
  readonly onToggle: (enabled: boolean) => void
  readonly onToggleLogs: () => void
  readonly onDelete: () => void
}

/** The actions cell, its own nowrap column so a phone scrolls the table
 *  sideways instead of squeezing the buttons. */
export function AutomationActions({
  block,
  busy,
  unreadable,
  onEdit,
  onToggle,
  onToggleLogs,
  onDelete,
}: AutomationActionsProps) {
  const { t } = useTranslation()
  return (
    <div className="flex justify-end gap-1">
      <Button
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation()
          onEdit()
        }}
        disabled={unreadable !== null}
        title={
          unreadable === null
            ? t('common.edit', 'Edit')
            : t(
                'automation.automationList.thisBlockCannotBeOpened',
                'This block cannot be opened visually',
              )
        }
      >
        <Pencil className="h-4 w-4" />
      </Button>

      <Tooltip>
        <TooltipTrigger>
          <Button
            variant="ghost"
            disabled
            title={t('automation.automationList.runActions', 'Run actions')}
          >
            <Play className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {t(
            'automation.automationList.runningAnAutomationByHand',
            'Running an automation by hand needs the automation-control authority, which is not wired up yet. There is deliberately no second way to execute one.',
          )}
        </TooltipContent>
      </Tooltip>

      <Button
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation()
          onToggleLogs()
        }}
        title={t('automation.automationList.logs', 'Logs')}
      >
        <ScrollText className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation()
          onToggle(!block.enabled)
        }}
        disabled={busy}
        title={block.enabled ? t('common.disable', 'Disable') : t('common.enable', 'Enable')}
      >
        {block.enabled ? t('common.disable', 'Disable') : t('common.enable', 'Enable')}
      </Button>
      <Button
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        title={t('common.delete', 'Delete')}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  )
}

export interface AutomationEmptyStateProps {
  readonly onCreate: () => void
}

/** Says only what is true: there are none. The tab used to explain that
 *  automations did not exist; repeating any of that now would be a lie. */
export function AutomationEmptyState({ onCreate }: AutomationEmptyStateProps) {
  const { t } = useTranslation()
  return (
    <Card>
      <div className="space-y-2 p-4">
        <p className="text-sm text-foreground">
          {t('automation.automationList.noAutomationsYet', 'No automations yet.')}
        </p>
        <p className="max-w-2xl text-xs text-foreground-subtle">
          {t(
            'automation.automationList.anAutomationIsATrigger',
            'An automation is a trigger, a set of conditions and a list of actions. It compiles to an ordinary block and runs in its own supervised process — there is no separate engine, so anything that goes wrong shows up here with a reason.',
          )}
        </p>
        <Button onClick={onCreate}>
          {t('automation.automationList.newAutomation', 'New automation')}
        </Button>
      </div>
    </Card>
  )
}
