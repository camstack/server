/**
 * The small pieces every quick-modal body is made of: a titled section, a
 * facts list, and the last-runs list. Bodies compose these, so the six sections
 * look like one.
 */
import type { AutomationRunTrace } from '@camstack/types'
import {
  Badge,
  Button,
  KeyValueList,
  SectionCard,
  Skeleton,
  useDeviceLabelById,
} from '@camstack/ui-library'
import { type ReactNode, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { formatRelativeTime } from '../../../components/device/hero/format'
import {
  OUTCOME_VARIANT,
  SCHEDULER_VARIANT,
  useOutcomeLabel,
  useSchedulerOutcomeLabel,
} from '../flow/RunsPanel'
import { type QuickRunRow, quickRunRows, runDurationParts } from './quick-runs'

export interface QuickSectionProps {
  readonly title: string
  readonly children: ReactNode
}

export function QuickSection({ title, children }: QuickSectionProps): ReactNode {
  const headingId = useId()
  return (
    <SectionCard headingId={headingId} title={title}>
      <div className="p-3">{children}</div>
    </SectionCard>
  )
}

export interface QuickFact {
  readonly key: string
  readonly value: ReactNode
}

/** A device named by its fleet label, linking to its page. */
export function QuickDeviceLink({ deviceId }: { readonly deviceId: number }): ReactNode {
  const label = useDeviceLabelById(deviceId, 'compact')
  return (
    <Link to={`/devices/${String(deviceId)}`} className="hover:underline">
      {label}
    </Link>
  )
}

/** Devices as a wrapped row of links; `empty` says there are none. */
export function QuickDeviceLinks({
  ids,
  empty,
}: {
  readonly ids: readonly number[]
  readonly empty: string
}): ReactNode {
  if (ids.length === 0) return <span className="text-foreground-subtle">{empty}</span>
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {ids.map((id) => (
        <QuickDeviceLink key={id} deviceId={id} />
      ))}
    </span>
  )
}

export function QuickFacts({ items }: { readonly items: readonly QuickFact[] }): ReactNode {
  return <KeyValueList items={[...items]} />
}

function DurationLabel({ ms }: { readonly ms: number }): ReactNode {
  const { t } = useTranslation()
  const parts = runDurationParts(ms)
  if (parts.unit === 'subSecond') return <>{t('build.quickModal.durationSub', '< 1 s')}</>
  if (parts.unit === 'seconds') {
    return <>{t('build.quickModal.durationSeconds', '{{s}} s', { s: parts.seconds })}</>
  }
  return (
    <>
      {t('build.quickModal.durationMinutes', '{{m}} min {{s}} s', {
        m: parts.minutes,
        s: parts.seconds,
      })}
    </>
  )
}

export interface QuickRunListProps {
  /** `undefined` while the ledger has not answered. */
  readonly traces: readonly AutomationRunTrace[] | undefined
  readonly failed: boolean
  readonly emptyLabel: string
  readonly kind: 'run' | 'fire'
  /** Opens the full run in the editor; absent when the editor cannot select a run. */
  readonly onOpenRun?: (runId: string) => void
}

function RunRow({
  row,
  kind,
  onOpenRun,
}: {
  readonly row: QuickRunRow
  readonly kind: 'run' | 'fire'
  readonly onOpenRun?: (runId: string) => void
}): ReactNode {
  const { t } = useTranslation()
  const outcomeLabel = useOutcomeLabel()
  const schedulerLabel = useSchedulerOutcomeLabel()
  const useScheduler = kind === 'fire' && row.scheduler !== null
  const variant =
    useScheduler && row.scheduler !== null
      ? SCHEDULER_VARIANT[row.scheduler]
      : OUTCOME_VARIANT[row.outcome]
  const label =
    useScheduler && row.scheduler !== null
      ? schedulerLabel(row.scheduler)
      : outcomeLabel(row.outcome)
  return (
    <li
      className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-xs"
      data-testid="quick-run-row"
    >
      <Badge variant={variant}>{label}</Badge>
      <span className="text-foreground-muted">{formatRelativeTime(row.at)}</span>
      <span className="text-foreground-subtle">
        <DurationLabel ms={row.durationMs} />
      </span>
      {row.reason !== null && (
        <span className="min-w-0 basis-full flex-1 break-words text-foreground sm:basis-0">
          {row.reason}
        </span>
      )}
      {onOpenRun !== undefined && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onOpenRun(row.runId)}
          data-testid="quick-run-open"
        >
          {t('build.quickModal.openRun', 'Open run')}
        </Button>
      )}
    </li>
  )
}

/** The last runs: pending, unknown and "none yet" are three different sentences. */
export function QuickRunList({
  traces,
  failed,
  emptyLabel,
  kind,
  onOpenRun,
}: QuickRunListProps): ReactNode {
  const { t } = useTranslation()
  if (traces === undefined) {
    return failed ? (
      <p className="text-xs text-foreground-subtle">
        {t('build.quickModal.runsUnknown', 'The runs could not be read.')}
      </p>
    ) : (
      <Skeleton className="h-10 w-full" />
    )
  }
  const rows = quickRunRows(traces)
  if (rows.length === 0) return <p className="text-xs text-foreground-subtle">{emptyLabel}</p>
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <RunRow key={row.runId} row={row} kind={kind} onOpenRun={onOpenRun} />
      ))}
    </ul>
  )
}
