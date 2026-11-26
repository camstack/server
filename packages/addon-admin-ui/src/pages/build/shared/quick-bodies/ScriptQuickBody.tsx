/**
 * Script quick body: where it runs, its state and last error, and its recent
 * block logs (the same `LogStream` the Scripts table opens).
 */
import { type CoreBlock, coreBlockAddonId } from '@camstack/types'
import { Badge, LogStream } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { badgeVariantForTone, describeBlockStatus } from '../../core-block-status'
import { type QuickFact, QuickFacts, QuickSection } from '../QuickParts'

export interface ScriptQuickBodyProps {
  readonly block: CoreBlock
}

export function ScriptQuickBody({ block }: ScriptQuickBodyProps): ReactNode {
  const { t } = useTranslation()
  const status = describeBlockStatus(block)
  const facts: QuickFact[] = [
    {
      key: t('build.quickModal.status', 'Status'),
      value: <Badge variant={badgeVariantForTone(status.tone)}>{status.label}</Badge>,
    },
  ]
  return (
    <>
      <QuickSection title={t('build.quickModal.summary', 'Summary')}>
        <QuickFacts items={facts} />
        <p className="mt-2 text-xs text-foreground-subtle">{status.detail}</p>
        {block.lastError !== undefined && (
          <p className="mt-2 text-xs text-danger">{block.lastError}</p>
        )}
      </QuickSection>
      <QuickSection title={t('build.quickModal.recentLogs', 'Recent logs')}>
        <LogStream addonId={coreBlockAddonId(block.id)} maxHeight="max-h-64" showFilters={false} />
      </QuickSection>
    </>
  )
}
