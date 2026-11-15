/**
 * The Interactions section of a device card's History view: who changed which
 * field, newest first. The capability is asked, not assumed (an unanswered
 * read is never "no actuations").
 */
import { useMemo, useState, type ReactElement } from 'react'
import { Info } from 'lucide-react'
import { useUiText, type UiTextFn } from '../../../contexts/ui-text'
import { useActionsList } from '../../../generated/system-hooks'
import { useCapabilityPresence } from '../../../hooks/use-capability-presence'
import { Badge } from '../../../primitives/badge'
import { Button } from '../../../primitives/button'
import { IconButton } from '../../../primitives/icon-button'
import { Skeleton } from '../../../primitives/skeleton'
import { trpc } from '../../../trpc-react'
import { ErrorBox } from '../../error-box'
import {
  ACTUATION_PAGE_SIZE,
  actionNamesFromList,
  actuationRow,
  actuationSection,
  mergeActuationPages,
  type ActuationAsk,
  type ActuationNameBook,
  type ActuationPhrases,
  type ActuationRowView,
} from './actuation-model'

export interface ActuationHistoryProps {
  readonly deviceId: number
}

function uiLocale(): string {
  if (typeof document === 'undefined') return 'en'
  const lang = document.documentElement.lang
  return lang.length > 0 ? lang : 'en'
}

function phrasesOf(t: UiTextFn): ActuationPhrases {
  return {
    justNow: t('uiLibrary.deviceCard.history.justNow', 'just now'),
    minutesAgo: (n) => t('uiLibrary.deviceCard.history.minutesAgo', '{{n}} min ago', { n }),
    hoursAgo: (n) => t('uiLibrary.deviceCard.history.hoursAgo', '{{n}} h ago', { n }),
    daysAgo: (n) => t('uiLibrary.deviceCard.history.daysAgo', '{{n}} d ago', { n }),
    on: t('uiLibrary.deviceCard.history.on', 'On'),
    off: t('uiLibrary.deviceCard.history.off', 'Off'),
    unknown: '—',
    device: t('uiLibrary.deviceCard.history.actorDevice', 'The device'),
    user: t('uiLibrary.deviceCard.history.actorUser', 'User'),
    automation: t('uiLibrary.deviceCard.history.actorAutomation', 'Automation'),
    addon: t('uiLibrary.deviceCard.history.actorAddon', 'Add-on'),
    scheduler: t('uiLibrary.deviceCard.history.actorScheduler', 'Schedule'),
    composition: t('uiLibrary.deviceCard.history.actorComposition', 'Composition'),
    node: t('uiLibrary.deviceCard.history.actorNode', 'This node'),
    confirmed: t('uiLibrary.deviceCard.history.outcome.confirmed', 'Confirmed'),
    deviceOutcome: t('uiLibrary.deviceCard.history.outcome.device', 'By the device'),
    already: t('uiLibrary.deviceCard.history.outcome.already', 'Already set'),
    unconfirmed: t('uiLibrary.deviceCard.history.outcome.unconfirmed', 'Unconfirmed'),
    failed: t('uiLibrary.deviceCard.history.outcome.failed', 'Failed'),
  }
}

function listAsk(pending: boolean, failed: boolean, count: number, hasNext: boolean): ActuationAsk {
  if (failed && count === 0) return { status: 'error' }
  if (pending) return { status: 'pending' }
  return { status: 'ok', count, nextCursor: hasNext ? 'more' : null }
}

interface ActuationRowsProps {
  readonly rows: readonly ActuationRowView[]
}

interface DetailLine {
  readonly label: string
  readonly value: string
}

function detailLines(row: ActuationRowView, t: UiTextFn): readonly DetailLine[] {
  const d = row.details
  const lines: DetailLine[] = [
    {
      label: t('uiLibrary.deviceCard.history.detail.when', 'When'),
      value: d.exact,
    },
    {
      label: t('uiLibrary.deviceCard.history.detail.capability', 'Capability'),
      value: d.capability,
    },
    {
      label: t('uiLibrary.deviceCard.history.detail.field', 'Field'),
      value: d.field,
    },
    {
      label: t('uiLibrary.deviceCard.history.detail.change', 'Change'),
      value: `${d.from} → ${d.to}`,
    },
    {
      label: t('uiLibrary.deviceCard.history.detail.actor', 'Who'),
      value: d.actorKind === d.actorName ? d.actorName : `${d.actorKind} · ${d.actorName}`,
    },
  ]
  if (d.command !== null) {
    lines.push({
      label: t('uiLibrary.deviceCard.history.detail.command', 'Command'),
      value: d.command,
    })
  }
  lines.push(
    {
      label: t('uiLibrary.deviceCard.history.detail.outcome', 'Outcome'),
      value: d.outcome,
    },
    {
      label: t('uiLibrary.deviceCard.history.detail.id', 'Row id'),
      value: d.rowId,
    },
  )
  return lines
}

function ActuationRow({ row }: { readonly row: ActuationRowView }): ReactElement {
  const t = useUiText()
  const [open, setOpen] = useState(false)
  const detailsId = `dc-actuation-details-${row.id}`
  return (
    <li
      data-testid="dc-actuation-row"
      data-outcome={row.outcome}
      className="flex flex-col gap-0.5 border-b border-border-subtle py-1.5 last:border-b-0"
    >
      <div className="flex items-center justify-between gap-2">
        <time
          className="min-w-0 truncate text-xs tabular-nums text-foreground-muted"
          title={row.details.exact}
        >
          {row.relative}
        </time>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge size="sm" variant={row.tone}>
            {row.outcomeLabel}
          </Badge>
          <span className="text-xs tabular-nums text-foreground" data-testid="dc-actuation-clock">
            {row.clock}
          </span>
          <IconButton
            icon={Info}
            size="sm"
            variant="ghost"
            aria-label={t('uiLibrary.deviceCard.history.detail.toggle', 'Details')}
            aria-expanded={open}
            aria-controls={detailsId}
            data-testid="dc-actuation-info"
            onClick={() => setOpen((v) => !v)}
          />
        </div>
      </div>
      <p className="min-w-0 text-sm text-foreground">
        <span className="font-medium">{row.field}</span>{' '}
        <span className="text-foreground-muted">{row.change}</span>
      </p>
      <p className="truncate text-xs text-foreground-muted">{row.actor}</p>
      {open ? (
        <dl
          id={detailsId}
          data-testid="dc-actuation-details"
          className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md bg-surface p-2 text-xs"
        >
          {detailLines(row, t).map((line) => (
            <div key={line.label} className="contents">
              <dt className="text-foreground-muted">{line.label}</dt>
              <dd className="min-w-0 break-words text-foreground">{line.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  )
}

function ActuationRows({ rows }: ActuationRowsProps): ReactElement {
  return (
    <ul className="flex flex-col" data-testid="dc-actuation-rows">
      {rows.map((row) => (
        <ActuationRow key={row.id} row={row} />
      ))}
    </ul>
  )
}

/** The actuations of one device. The History view shows this instead of the values. */
export function ActuationHistory({ deviceId }: ActuationHistoryProps): ReactElement | null {
  const t = useUiText()
  const presence = useCapabilityPresence('device-transitions')
  const query = trpc.deviceTransitions.listTransitions.useInfiniteQuery(
    { deviceId, limit: ACTUATION_PAGE_SIZE },
    {
      enabled: presence === 'present',
      retry: false,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  )
  const transitions = useMemo(
    () => mergeActuationPages((query.data?.pages ?? []).map((page) => page.transitions)),
    [query.data],
  )
  const hasAction = transitions.some((entry) => entry.actor.kind === 'action')
  const namesQuery = useActionsList(
    {},
    {
      enabled: presence === 'present' && hasAction,
      retry: false,
      staleTime: 60_000,
    },
  )
  const book = useMemo<ActuationNameBook>(() => {
    const names = actionNamesFromList(namesQuery.data)
    return {
      actionName: (id) => names.get(id),
      automationName: (id) => names.get(id),
    }
  }, [namesQuery.data])
  const phrases = phrasesOf(t)
  const locale = uiLocale()
  const rows = transitions.map((entry) => actuationRow(entry, Date.now(), locale, phrases, book))
  const section = actuationSection(
    presence,
    listAsk(query.isPending, query.isError, transitions.length, query.hasNextPage),
  )
  if (section.kind === 'hidden') return null
  return (
    <section className="flex flex-col gap-1.5" data-testid="dc-actuations">
      {section.kind === 'skeleton' ? (
        <div className="flex flex-col gap-2" data-testid="dc-actuations-skeleton">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      ) : section.kind === 'unread' ? (
        <div data-testid="dc-actuations-unread">
          <ErrorBox
            message={t(
              'uiLibrary.deviceCard.history.actuationsUnread',
              'The actuations could not be read',
            )}
          />
        </div>
      ) : section.kind === 'empty' ? (
        <p
          className="py-2 text-center text-xs text-foreground-muted"
          data-testid="dc-actuations-empty"
        >
          {t('uiLibrary.deviceCard.history.noActuations', 'No actuations yet')}
        </p>
      ) : (
        <>
          <ActuationRows rows={rows} />
          {section.nextCursor === null ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={query.isFetchingNextPage}
              data-testid="dc-actuations-more"
              onClick={() => {
                void query.fetchNextPage()
              }}
            >
              {t('uiLibrary.deviceCard.history.loadMore', 'Load more')}
            </Button>
          )}
        </>
      )}
    </section>
  )
}
