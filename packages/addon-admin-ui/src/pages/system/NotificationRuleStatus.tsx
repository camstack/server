/**
 * THE LIVE LINE under a rule's title.
 *
 * One component for every rule kind, because it is one question — "what is this
 * rule doing right now" — and the server answers it as a discriminated union
 * (`nc.getRuleStatus`). A per-kind component would be the beginning of a
 * per-kind page.
 *
 * It POLLS, lightly and only while mounted: an occupancy count is a live fact
 * and a card showing the value from when the dialog opened is a card that lies
 * within seconds. A timelapse render can take thirty minutes, so the same poll
 * is what turns "never produced" into "rendering for 4 min" without the
 * operator reloading. `refetchInterval` stops with the component, so a closed
 * dialog costs nothing.
 *
 * Kinds with no live state render NOTHING — not an empty box. `kind: 'none'` is
 * the server saying so, and drawing a placeholder for it would put a permanently
 * empty panel on every detection rule.
 */

import { useSystem } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Radio } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  NC_ADDON_ID,
  NC_RULE_STATUS_ACTION,
  groupedStatusCounts,
  type NcGroupedStatus,
  type NcRuleStatus,
  occupancyStatusLine,
  parseRuleStatus,
  timelapseDeviceLine,
} from './notification-rule-status'

/**
 * How often the line refreshes. Five seconds is the cheapest cadence that still
 * reads as live for a count: the call reads an in-process mirror plus one
 * ZoneAnalytics snapshot, and the operator has a dialog open in front of it.
 */
const STATUS_POLL_MS = 5_000

export interface NotificationRuleStatusProps {
  /** The rule to describe. Either an `NcRule` or a timelapse rule — the server
   *  decides which store owns the id, so the caller does not have to. */
  readonly ruleId: string
  /** Resolve a camera's display name; absent = the numeric id is shown. */
  readonly cameraName?: (deviceId: number) => string
}

export interface GroupedStatusLinesProps {
  readonly status: NcGroupedStatus
  readonly now: number
  readonly name: (deviceId: number) => string
}

/**
 * A grouped rule's live lines: the headline ("1 open window · 1 waiting") and one line per
 * window. No window open is an ANSWER ("nothing waiting"), stated — the parser already
 * turned an unreadable list into no card at all (D315).
 */
export function GroupedStatusLines({ status, now, name }: GroupedStatusLinesProps) {
  const { t } = useTranslation()
  // D315: null windows = the node could not say. Never "No window open".
  if (status.openWindows === null) {
    return (
      <p className="flex items-start gap-1.5">
        <Radio className="mt-0.5 h-3 w-3 shrink-0 text-border" />
        <span data-testid="nc-grouped-status-headline">
          {t('notificationRules.status.grouped.unknown', {
            reason: status.reason ?? '',
            defaultValue: 'Open windows unknown — {{reason}}',
          })}
        </span>
      </p>
    )
  }
  const openWindows = status.openWindows
  const { windows, waiting } = groupedStatusCounts(openWindows)
  return (
    <>
      <p className="flex items-start gap-1.5">
        <Radio
          className={`mt-0.5 h-3 w-3 shrink-0 ${windows > 0 ? 'text-primary' : 'text-border'}`}
        />
        <span data-testid="nc-grouped-status-headline">
          {windows === 0
            ? t('notificationRules.status.grouped.none', 'No window open')
            : `${t('notificationRules.status.grouped.windows', {
                count: windows,
                defaultValue_one: '{{count}} open window',
                defaultValue_other: '{{count}} open windows',
              })} · ${t('notificationRules.status.grouped.waiting', {
                count: waiting,
                defaultValue: '{{count}} waiting',
              })}`}
        </span>
      </p>
      {openWindows.map((window) => (
        <p key={window.windowKey} className="flex items-start gap-1.5">
          <span className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {t('notificationRules.status.grouped.windowLine', {
              camera: name(window.deviceId),
              members: window.members,
              pending: window.pending,
              seconds: Math.max(0, Math.ceil((window.closesAt - now) / 1_000)),
              defaultValue:
                '{{camera}} · {{members}} in the window · {{pending}} waiting · closes within {{seconds}} s',
            })}
          </span>
        </p>
      ))}
    </>
  )
}

export function NotificationRuleStatus({ ruleId, cameraName }: NotificationRuleStatusProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const query = useQuery({
    queryKey: ['pipelineAnalytics', 'nc.getRuleStatus', ruleId],
    refetchInterval: STATUS_POLL_MS,
    queryFn: async (): Promise<NcRuleStatus | null> => {
      // `.mutate` and not `.query`: the generic bridge is declared as a
      // mutation whatever the action's own kind is (every other nc.* read on
      // this page does the same), so a `.query` here does not type-check and
      // would not route.
      const raw = await system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_RULE_STATUS_ACTION,
        input: { ruleId },
      })
      return parseRuleStatus(raw)
    },
  })

  const status = query.data
  // A hub that does not serve the action, or one whose answer this build cannot
  // read, renders NOTHING rather than an error: the status is a bonus line on an
  // editor that works without it, and a red box here would read as a broken rule.
  if (status === undefined || status === null) return null
  if (status.kind === 'none') return null

  const now = Date.now()
  const name = (deviceId: number): string =>
    cameraName?.(deviceId) ?? t('system.notificationRuleStatus.cameraFallback', { deviceId })

  return (
    <div
      data-testid="nc-rule-status"
      className="rounded-md border border-border bg-surface-subtle px-3 py-2 text-[11px] text-foreground-subtle space-y-1"
    >
      {status.kind === 'occupancy' && (
        <p className="flex items-start gap-1.5">
          {status.unavailable !== undefined || status.warning !== undefined ? (
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
          ) : (
            <Radio className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
          )}
          <span>
            <span className="text-foreground">{name(status.deviceId)}</span> —{' '}
            {occupancyStatusLine(status, now)}
          </span>
        </p>
      )}

      {status.kind === 'grouped' && <GroupedStatusLines status={status} now={now} name={name} />}

      {status.kind === 'timelapse' && (
        <>
          {status.devices.map((device) => (
            <p key={device.deviceId} className="flex items-start gap-1.5">
              <Radio
                className={`mt-0.5 h-3 w-3 shrink-0 ${
                  device.rendering !== undefined ? 'text-primary animate-pulse' : 'text-border'
                }`}
              />
              <span>
                {timelapseDeviceLine(device, name(device.deviceId), now)}
                {device.lastArtifact !== undefined && (
                  <>
                    {' · '}
                    {/* The bytes route is authenticated and relative — the
                        browser is already the session that may read it. */}
                    <a
                      className="text-primary hover:underline"
                      href={`/${device.lastArtifact.downloadPath.replace(/^\//, '')}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('common.open')}
                    </a>
                  </>
                )}
              </span>
            </p>
          ))}
          <p className="flex items-start gap-1.5">
            <span className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              {status.nextWindow !== undefined
                ? t(
                    'system.notificationRuleStatus.nextWindowOpens',
                    'Next window opens {{value1}}',
                    { value1: new Date(status.nextWindow.startMs).toLocaleString() },
                  )
                : t(
                    'system.notificationRuleStatus.noFurtherWindowOpensIn',
                    'No further window opens in the next nine days',
                  )}
              {status.settleMs > 0 &&
                ` · ${t('system.notificationRuleStatus.settled', { minutes: Math.round(status.settleMs / 60_000) })}`}
            </span>
          </p>
        </>
      )}
    </div>
  )
}

export default NotificationRuleStatus
