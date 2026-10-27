/**
 * A threshold, a sum, a difference, a ratio or an expression on its device
 * page: the reading it publishes now (D944). A sum also says how many inputs
 * took part, because it leaves an unreporting input out instead of reading 0.
 */
import type {
  ArithmeticHelperSpec,
  ExpressionHelperSpec,
  ThresholdHelperSpec,
} from '@camstack/types'
import { ErrorBox, SECTION_BODY, SectionCard, StatCard } from '@camstack/ui-library'
import { Sigma } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { groupStatusFromSnapshot, type SnapshotRead } from '../composition-editor/helper-form-model'

export interface HelperMathStatusProps {
  readonly helper: ThresholdHelperSpec | ArithmeticHelperSpec | ExpressionHelperSpec
  readonly snapshot: SnapshotRead
}

type Output =
  | { readonly kind: 'pending' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }

export function HelperMathStatus({ helper, snapshot }: HelperMathStatusProps): ReactNode {
  const { t } = useTranslation()
  const output = outputOf(snapshot, helper)
  const status = helper.kind === 'arithmetic' ? groupStatusFromSnapshot(snapshot) : null
  return (
    <SectionCard
      headingId="helper-math-status"
      title={t(`helper.template.${titleKey(helper)}`)}
      icon={Sigma}
      testId="helper-math-status"
    >
      <div className={`${SECTION_BODY} flex flex-col gap-3`}>
        {output.kind === 'pending' && (
          <p role="status" className="text-xs text-foreground-subtle">
            {t('helper.outputPending')}
          </p>
        )}
        {output.kind === 'number' && (
          <StatCard value={String(output.value)} label={t('helper.output')} />
        )}
        {output.kind === 'boolean' && (
          <StatCard
            value={output.value ? t('helper.on') : t('helper.off')}
            label={t('helper.output')}
          />
        )}
        {output.kind === 'empty' && (
          <p className="text-xs text-foreground-subtle">{t('helper.noReading')}</p>
        )}
        {status?.kind === 'ready' && (
          <p className="text-sm text-foreground" data-testid="helper-reporting">
            {t('helper.reporting', { included: status.included, total: status.total })}
          </p>
        )}
        {status?.kind === 'unavailable' && (
          <ErrorBox title={t('helper.outputUnavailable')} message={status.message} />
        )}
      </div>
    </SectionCard>
  )
}

function titleKey(helper: HelperMathStatusProps['helper']): string {
  return helper.kind === 'arithmetic' ? helper.op : helper.kind
}

function outputCap(helper: HelperMathStatusProps['helper']): { cap: string; field: string } {
  if (helper.kind === 'threshold') return { cap: 'binary', field: 'on' }
  if (helper.kind === 'expression' && helper.output === 'boolean') {
    return { cap: 'binary', field: 'on' }
  }
  return { cap: 'numeric-sensor', field: 'value' }
}

function outputOf(snapshot: SnapshotRead, helper: HelperMathStatusProps['helper']): Output {
  if (snapshot.kind === 'pending') return { kind: 'pending' }
  if (snapshot.kind !== 'answered') return { kind: 'empty' }
  const where = outputCap(helper)
  const value = snapshot.caps[where.cap]?.[where.field]
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'number', value }
  if (typeof value === 'boolean') return { kind: 'boolean', value }
  return { kind: 'empty' }
}
