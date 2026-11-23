/**
 * Automation quick body: what starts it, how it behaves when it is already
 * running, and where it runs. Its last runs are their own tab (`QuickLastRuns`).
 */
import { type AutomationRunMode, type CoreBlock, countWhenLeaves } from '@camstack/types'
import { Badge } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { triggerSummaryOf } from '../../automation/AutomationList'
import { parseRecipeFromCode } from '../../automation/recipe-from-code'
import { badgeVariantForTone, describeBlockStatus } from '../../core-block-status'
import { QuickFacts, type QuickFact, QuickSection } from '../QuickParts'

export function useRunModeLabel(): (mode: AutomationRunMode) => string {
  const { t } = useTranslation()
  return (mode) => {
    switch (mode.mode) {
      case 'single':
        return t('flow.runMode.single', 'Skip it')
      case 'restart':
        return t('flow.runMode.restart', 'Restart the run')
      case 'queued':
        return t('build.quickModal.runModeQueued', 'Queue it, up to {{max}}', {
          max: mode.max,
        })
      case 'parallel':
        return t('build.quickModal.runModeParallel', 'Run at the same time, up to {{max}}', {
          max: mode.max,
        })
      default:
        return t('build.quickModal.runModeCooldown', 'Wait {{minutes}} min after a run', {
          minutes: mode.minutes,
        })
    }
  }
}

export interface AutomationQuickBodyProps {
  readonly block: CoreBlock
}

export function AutomationQuickBody({ block }: AutomationQuickBodyProps): ReactNode {
  const { t } = useTranslation()
  const runModeLabel = useRunModeLabel()
  const parsed = parseRecipeFromCode(block.code)
  const status = describeBlockStatus(block)
  const facts: QuickFact[] = [
    {
      key: t('build.quickModal.status', 'Status'),
      value: <Badge variant={badgeVariantForTone(status.tone)}>{status.label}</Badge>,
    },
    {
      key: t('build.quickModal.placement', 'Placement'),
      value: block.placement,
    },
  ]
  if (parsed.ok) {
    const trigger = triggerSummaryOf(parsed.recipe)
    facts.push(
      {
        key: t('build.automationsTab.trigger', 'Trigger'),
        value: trigger === '' ? t('automation.automationList.noTrigger', 'No trigger') : trigger,
      },
      {
        key: t('build.quickModal.conditions', 'Conditions'),
        value: t('build.quickModal.leaves', '{{count}} checks in the When tree', {
          count: countWhenLeaves(parsed.recipe.when),
        }),
      },
      {
        key: t('flow.runMode.label', 'When it is already running'),
        value: runModeLabel(parsed.recipe.runMode ?? { mode: 'single' }),
      },
    )
  }
  return (
    <>
      <QuickSection title={t('build.quickModal.summary', 'Summary')}>
        <QuickFacts items={facts} />
        {!parsed.ok && (
          <p className="mt-2 text-xs text-warning">
            {t('automation.editor.listUnreadable', { reason: parsed.reason })}
          </p>
        )}
        {block.lastError !== undefined && (
          <p className="mt-2 text-xs text-danger">{block.lastError}</p>
        )}
      </QuickSection>
    </>
  )
}
