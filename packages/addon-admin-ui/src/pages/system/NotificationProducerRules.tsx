/**
 * The scheduled producers (Summaries, Timelapses, Calendar events) as seen
 * from the unified Rules table.
 *
 * The Rules page renders ONE table over every kind of rule. Its event rows are
 * hosted by the page itself; the three producer families live here so the page
 * does not grow three more query/mutation/editor blocks:
 *   - the three list queries (same keys the standalone pages use, so a create
 *     or delete never leaves a tab badge disagreeing with the rows),
 *   - enable / delete / test mutations behind the column deps,
 *   - the editors and confirm dialogs, mounted as `overlays`, so a create from
 *     All opens the editor right there — no tab switch.
 */

import type { NcTaxonomy, Target } from '@camstack/types'
import { Button, ErrorBox, Select, useSystem } from '@camstack/ui-library'
import { useMutation, useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import type { DeviceFleetView } from './device-fleet-view'
import { NotificationCalendarEventsEditor } from './NotificationCalendarEventsEditor'
import type { CalendarEventsColumnsDeps } from './NotificationCalendarEventsPage'
import { NotificationSummaryEditor } from './NotificationSummaryEditor'
import { NotificationTimelapseEditor } from './NotificationTimelapseEditor'
import { SUMMARIES_QUERY_KEY, type SummaryColumnsDeps } from './NotificationSummaries'
import { TIMELAPSES_QUERY_KEY, type TimelapseColumnsDeps } from './NotificationTimelapses'
import {
  CALENDAR_EVENTS_QUERY_KEY,
  type CalendarEventsRuleView,
  isEditableCalendarEventsRule,
  NC_DELETE_CALENDAR_EVENTS_RULE_ACTION,
  NC_LIST_CALENDAR_EVENTS_RULES_ACTION,
  NC_UPSERT_CALENDAR_EVENTS_RULE_ACTION,
  parseCalendarEventsRules,
} from './notification-calendar-events.helpers'
import type { DigestCameraOption, DigestTargetOption } from './notification-digest-fields'
import { DigestTestConfirm } from './notification-digest-fields'
import {
  isEditableSummaryRule,
  NC_ADDON_ID,
  NC_DELETE_SUMMARY_RULE_ACTION,
  NC_LIST_SUMMARY_RULES_ACTION,
  NC_TEST_SUMMARY_RULE_ACTION,
  NC_UPSERT_SUMMARY_RULE_ACTION,
  parseSummaryRules,
  parseSummaryTestOutcome,
  type SummaryEditableRule,
  type SummaryRuleView,
  type SummaryTestOutcome,
  summaryTestWindow,
} from './notification-summaries.helpers'
import {
  isTimelapseRuleEditable,
  NC_DELETE_TIMELAPSE_RULE_ACTION,
  NC_LIST_TIMELAPSE_RULES_ACTION,
  NC_TEST_TIMELAPSE_RULE_ACTION,
  NC_UPSERT_TIMELAPSE_RULE_ACTION,
  parseTimelapseRules,
  parseTimelapseTestOutcome,
  type TimelapseRuleView,
  type TimelapseTestOutcome,
} from './notification-timelapse.helpers'
import type { UnifiedProducerKind, UnifiedRuleRow } from './unified-rules-model'
import type { RulesAreaKey } from './notification-rules-area'
import { useTranslation } from 'react-i18next'

/** What a producer row hands back to the host when it is opened. */
export type ProducerRuleRow = Extract<
  UnifiedRuleRow,
  { readonly family: 'summary' | 'timelapse' | 'calendar-events' }
>

type EditorState =
  | { readonly mode: 'closed' }
  | { readonly mode: 'summary'; readonly rule: SummaryEditableRule | null }
  | { readonly mode: 'timelapse'; readonly rule: TimelapseRuleView | null }
  | { readonly mode: 'calendar-events'; readonly rule: CalendarEventsRuleView | null }

interface TimelapseTestRequest {
  readonly rule: TimelapseRuleView
  readonly deviceId: number | null
}

export interface ProducerRulesHostInput {
  /** Cameras the digest/timelapse editors may pick. */
  readonly cameras: readonly DigestCameraOption[]
  /** The fleet behind `cameras`, and whether it ANSWERED (D315). */
  readonly fleet: DeviceFleetView
  readonly targets: readonly Target[]
  /** Picker vocabulary; absent on a hub that predates it. */
  readonly taxonomy: NcTaxonomy | undefined
}

export interface ProducerColumnDeps {
  readonly summary: SummaryColumnsDeps
  readonly timelapse: TimelapseColumnsDeps
  readonly calendar: CalendarEventsColumnsDeps
}

export interface ProducerRulesHost {
  readonly summaries: readonly SummaryRuleView[]
  readonly timelapses: readonly TimelapseRuleView[]
  readonly calendarEvents: readonly CalendarEventsRuleView[]
  /** True while any producer list has not answered its first read. */
  readonly loading: boolean
  readonly columnDeps: ProducerColumnDeps
  /** Open the editor for a producer row (no-op on a read-only rule). */
  readonly open: (row: ProducerRuleRow) => void
  /** Open a blank editor for a producer kind — in place, no tab switch. */
  readonly create: (kind: UnifiedProducerKind) => void
  /** Errors, test outcomes and "not available on this hub" notices. */
  readonly notices: (area: RulesAreaKey) => ReactNode
  /**
   * True when the active producer tab's list failed or is unreadable — the
   * ErrorBox already answers; the empty hint must not also claim "no rules".
   */
  readonly listFailed: (area: RulesAreaKey) => boolean
  /** Editors and confirm dialogs — mount once at the end of the page. */
  readonly overlays: ReactNode
}

const UNAVAILABLE_COPY: Readonly<
  Record<UnifiedProducerKind, { readonly titleKey: string; readonly messageKey: string }>
> = {
  summary: {
    titleKey: 'system.notificationProducerRules.summaryUnavailableTitle',
    messageKey: 'system.notificationProducerRules.summaryUnavailableMessage',
  },
  timelapse: {
    titleKey: 'system.notificationProducerRules.timelapseUnavailableTitle',
    messageKey: 'system.notificationProducerRules.timelapseUnavailableMessage',
  },
  'calendar-events': {
    titleKey: 'system.notificationProducerRules.calendarEventsUnavailableTitle',
    messageKey: 'system.notificationProducerRules.calendarEventsUnavailableMessage',
  },
}

const UNREADABLE_MESSAGE_KEY = 'system.notificationProducerRules.unreadableMessage'

function producerKindOfArea(area: RulesAreaKey): UnifiedProducerKind | null {
  if (area === 'summaries') return 'summary'
  if (area === 'timelapses') return 'timelapse'
  if (area === 'calendar-events') return 'calendar-events'
  return null
}

export function useProducerRulesHost({
  cameras,
  fleet,
  targets,
  taxonomy,
}: ProducerRulesHostInput): ProducerRulesHost {
  const { t } = useTranslation()
  const system = useSystem()
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })
  const [summaryTestRule, setSummaryTestRule] = useState<SummaryRuleView | null>(null)
  const [summaryOutcome, setSummaryOutcome] = useState<SummaryTestOutcome | null>(null)
  const [timelapseTest, setTimelapseTest] = useState<TimelapseTestRequest | null>(null)
  const [timelapseOutcome, setTimelapseOutcome] = useState<TimelapseTestOutcome | null>(null)

  // ── Lists ──────────────────────────────────────────────────────────
  const summariesQuery = useQuery({
    queryKey: SUMMARIES_QUERY_KEY,
    queryFn: async (): Promise<readonly SummaryRuleView[] | null> => {
      const raw = await system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_LIST_SUMMARY_RULES_ACTION,
        input: {},
      })
      return parseSummaryRules(raw)
    },
  })
  const timelapsesQuery = useQuery({
    queryKey: TIMELAPSES_QUERY_KEY,
    queryFn: async (): Promise<readonly TimelapseRuleView[] | null> => {
      const raw = await system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_LIST_TIMELAPSE_RULES_ACTION,
        input: {},
      })
      return parseTimelapseRules(raw)
    },
  })
  const calendarQuery = useQuery({
    queryKey: CALENDAR_EVENTS_QUERY_KEY,
    queryFn: async (): Promise<readonly CalendarEventsRuleView[] | null> => {
      const raw = await system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_LIST_CALENDAR_EVENTS_RULES_ACTION,
        input: {},
      })
      return parseCalendarEventsRules(raw)
    },
  })

  const summaries = summariesQuery.data ?? []
  const timelapses = timelapsesQuery.data ?? []
  const calendarEvents = calendarQuery.data ?? []

  // ── Mutations ──────────────────────────────────────────────────────
  const toggleSummary = useMutation({
    mutationFn: (vars: { readonly ruleId: string; readonly enabled: boolean }) =>
      system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_UPSERT_SUMMARY_RULE_ACTION,
        input: { ruleId: vars.ruleId, patch: { enabled: vars.enabled } },
      }),
    onSuccess: () => void summariesQuery.refetch(),
  })
  const deleteSummary = useMutation({
    mutationFn: (ruleId: string) =>
      system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_DELETE_SUMMARY_RULE_ACTION,
        input: { ruleId },
      }),
    onSuccess: () => void summariesQuery.refetch(),
  })
  const testSummary = useMutation({
    mutationFn: async (ruleId: string): Promise<SummaryTestOutcome | null> => {
      const raw = await system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_TEST_SUMMARY_RULE_ACTION,
        // An EXPLICIT window: a motion rule that has seen nothing has no window
        // of its own, and "no window has closed recently" tests nothing.
        input: { ruleId, ...summaryTestWindow(Date.now()) },
      })
      return parseSummaryTestOutcome(raw)
    },
    onSuccess: (outcome) => {
      setSummaryTestRule(null)
      setSummaryOutcome(outcome)
    },
  })

  const toggleTimelapse = useMutation({
    mutationFn: (vars: { readonly ruleId: string; readonly enabled: boolean }) =>
      system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_UPSERT_TIMELAPSE_RULE_ACTION,
        input: { ruleId: vars.ruleId, patch: { enabled: vars.enabled } },
      }),
    onSuccess: () => void timelapsesQuery.refetch(),
  })
  const deleteTimelapse = useMutation({
    mutationFn: (ruleId: string) =>
      system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_DELETE_TIMELAPSE_RULE_ACTION,
        input: { ruleId },
      }),
    onSuccess: () => void timelapsesQuery.refetch(),
  })
  const testTimelapse = useMutation({
    mutationFn: async (vars: {
      readonly ruleId: string
      readonly deviceId: number
    }): Promise<TimelapseTestOutcome | null> => {
      const raw = await system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_TEST_TIMELAPSE_RULE_ACTION,
        input: vars,
      })
      return parseTimelapseTestOutcome(raw)
    },
    onSuccess: (outcome) => {
      setTimelapseTest(null)
      setTimelapseOutcome(outcome)
    },
  })

  const toggleCalendar = useMutation({
    mutationFn: (vars: { readonly ruleId: string; readonly enabled: boolean }) =>
      system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_UPSERT_CALENDAR_EVENTS_RULE_ACTION,
        input: { ruleId: vars.ruleId, patch: { enabled: vars.enabled } },
      }),
    onSuccess: () => void calendarQuery.refetch(),
  })
  const deleteCalendar = useMutation({
    mutationFn: (ruleId: string) =>
      system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_DELETE_CALENDAR_EVENTS_RULE_ACTION,
        input: { ruleId },
      }),
    onSuccess: () => void calendarQuery.refetch(),
  })

  // ── Derived vocabulary ─────────────────────────────────────────────
  const digestCameras = cameras.toSorted((a, b) => a.name.localeCompare(b.name))
  const targetOptions: readonly DigestTargetOption[] = targets.map((t) => ({
    id: t.id,
    name: t.name,
    enabled: t.enabled,
  }))
  const targetNameById = new Map(targetOptions.map((t) => [t.id, t.name]))
  const cameraNameById = new Map(digestCameras.map((c) => [c.id, c.name]))
  const nowMs = Date.now()

  const columnDeps: ProducerColumnDeps = {
    summary: {
      nowMs,
      targetNameById,
      deletePending: deleteSummary.isPending,
      onToggle: (rule, enabled) => toggleSummary.mutate({ ruleId: rule.id, enabled }),
      onOpen: (rule) => {
        if (isEditableSummaryRule(rule)) setEditor({ mode: 'summary', rule })
      },
      onTest: setSummaryTestRule,
      onConfirmDelete: (rule) => deleteSummary.mutate(rule.id),
    },
    timelapse: {
      nowMs,
      cameraNameById,
      targetNameById,
      deletePending: deleteTimelapse.isPending,
      onToggle: (rule, enabled) => toggleTimelapse.mutate({ ruleId: rule.id, enabled }),
      onOpen: (rule) => {
        if (isTimelapseRuleEditable(rule)) setEditor({ mode: 'timelapse', rule })
      },
      onTest: (rule) => setTimelapseTest({ rule, deviceId: rule.deviceIds[0] ?? null }),
      onConfirmDelete: (rule) => deleteTimelapse.mutate(rule.id),
    },
    calendar: {
      nowMs,
      targetNameById,
      deletePending: deleteCalendar.isPending,
      onToggle: (rule, enabled) => toggleCalendar.mutate({ ruleId: rule.id, enabled }),
      onOpen: (rule) => {
        if (isEditableCalendarEventsRule(rule)) setEditor({ mode: 'calendar-events', rule })
      },
      onConfirmDelete: (rule) => deleteCalendar.mutate(rule.id),
    },
  }

  const open = (row: ProducerRuleRow): void => {
    switch (row.family) {
      case 'summary':
        columnDeps.summary.onOpen(row.rule)
        return
      case 'timelapse':
        columnDeps.timelapse.onOpen(row.rule)
        return
      case 'calendar-events':
        columnDeps.calendar.onOpen(row.rule)
        return
    }
  }

  const create = (kind: UnifiedProducerKind): void => {
    if (kind === 'summary') setEditor({ mode: 'summary', rule: null })
    else if (kind === 'timelapse') setEditor({ mode: 'timelapse', rule: null })
    else setEditor({ mode: 'calendar-events', rule: null })
  }

  // ── Notices ────────────────────────────────────────────────────────
  const unavailableOf = (kind: UnifiedProducerKind): { readonly unreadable: boolean } | null => {
    const query =
      kind === 'summary' ? summariesQuery : kind === 'timelapse' ? timelapsesQuery : calendarQuery
    if (query.isLoading) return null
    if (query.isError) return { unreadable: false }
    if (query.data === null) return { unreadable: true }
    return null
  }

  const refetchOf = (kind: UnifiedProducerKind): void => {
    if (kind === 'summary') void summariesQuery.refetch()
    else if (kind === 'timelapse') void timelapsesQuery.refetch()
    else void calendarQuery.refetch()
  }

  const listFailed = (area: RulesAreaKey): boolean => {
    const areaKind = producerKindOfArea(area)
    return areaKind !== null && unavailableOf(areaKind) !== null
  }

  const notices = (area: RulesAreaKey): ReactNode => {
    const areaKind = producerKindOfArea(area)
    const unavailable = areaKind === null ? null : unavailableOf(areaKind)
    return (
      <>
        {areaKind !== null && unavailable !== null && (
          <ErrorBox
            title={t(UNAVAILABLE_COPY[areaKind].titleKey)}
            message={t(
              unavailable.unreadable
                ? UNREADABLE_MESSAGE_KEY
                : UNAVAILABLE_COPY[areaKind].messageKey,
            )}
            onRetry={() => refetchOf(areaKind)}
          />
        )}
        {deleteSummary.isError && (
          <ErrorBox
            title={t(
              'system.notificationProducerRules.couldNotDeleteTheRule',
              'Could not delete the rule',
            )}
            message={String(deleteSummary.error)}
          />
        )}
        {deleteTimelapse.isError && (
          <ErrorBox
            title={t(
              'system.notificationProducerRules.couldNotDeleteTheRule',
              'Could not delete the rule',
            )}
            message={String(deleteTimelapse.error)}
          />
        )}
        {deleteCalendar.isError && (
          <ErrorBox
            title={t(
              'system.notificationProducerRules.couldNotDeleteTheRule',
              'Could not delete the rule',
            )}
            message={String(deleteCalendar.error)}
          />
        )}
        {testSummary.isError && (
          <ErrorBox
            title={t('system.notificationProducerRules.theTestRunFailed', 'The test run failed')}
            message={String(testSummary.error)}
          />
        )}
        {testTimelapse.isError && (
          <ErrorBox
            title={t('system.notificationProducerRules.theTestRunFailed', 'The test run failed')}
            message={String(testTimelapse.error)}
          />
        )}
        {summaryOutcome !== null && (
          <SummaryOutcomeNotice
            outcome={summaryOutcome}
            onDismiss={() => setSummaryOutcome(null)}
          />
        )}
        {timelapseOutcome !== null && (
          <TimelapseOutcomeNotice
            outcome={timelapseOutcome}
            onDismiss={() => setTimelapseOutcome(null)}
          />
        )}
      </>
    )
  }

  // ── Overlays ───────────────────────────────────────────────────────
  const closeEditor = (): void => setEditor({ mode: 'closed' })

  const overlays = (
    <>
      {editor.mode === 'summary' && (
        <NotificationSummaryEditor
          rule={editor.rule}
          cameras={digestCameras}
          fleet={fleet}
          targets={targetOptions}
          taxonomy={taxonomy}
          onCancel={closeEditor}
          onSaved={() => {
            closeEditor()
            void summariesQuery.refetch()
          }}
        />
      )}
      {editor.mode === 'timelapse' && (
        <NotificationTimelapseEditor
          rule={editor.rule}
          cameras={digestCameras}
          fleet={fleet}
          targets={targetOptions}
          onCancel={closeEditor}
          onSaved={() => {
            closeEditor()
            void timelapsesQuery.refetch()
          }}
        />
      )}
      {editor.mode === 'calendar-events' && (
        <NotificationCalendarEventsEditor
          rule={editor.rule}
          targets={targetOptions}
          onCancel={closeEditor}
          onSaved={() => {
            closeEditor()
            void calendarQuery.refetch()
          }}
        />
      )}

      <DigestTestConfirm
        open={summaryTestRule !== null}
        ruleName={summaryTestRule?.name ?? ''}
        windowDescription="the last 3 hours"
        targetDescription={`${summaryTestRule?.targets.length ?? 0} target${
          (summaryTestRule?.targets.length ?? 0) === 1 ? '' : 's'
        }`}
        pending={testSummary.isPending}
        onCancel={() => setSummaryTestRule(null)}
        onConfirm={() => {
          if (summaryTestRule !== null) testSummary.mutate(summaryTestRule.id)
        }}
      />

      <DigestTestConfirm
        open={timelapseTest !== null}
        ruleName={timelapseTest?.rule.name ?? ''}
        windowDescription="its last closed window"
        targetDescription={`${timelapseTest?.rule.targets.length ?? 0} target${
          (timelapseTest?.rule.targets.length ?? 0) === 1 ? '' : 's'
        }`}
        pending={testTimelapse.isPending}
        confirmDisabled={timelapseTest?.deviceId === null}
        extra={
          timelapseTest === null ? null : (
            <div>
              {/* One rule is SEVERAL videos: the action renders exactly one
                  camera, so the choice is explicit rather than "the first". */}
              <label className="mb-1 block text-[11px] font-medium text-foreground">
                {t('system.notificationProducerRules.whichCamera', 'Which camera')}
              </label>
              <Select
                value={timelapseTest.deviceId === null ? '' : String(timelapseTest.deviceId)}
                options={timelapseTest.rule.deviceIds.map((id) => ({
                  value: String(id),
                  label: cameraNameById.get(id) ?? `#${id}`,
                }))}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  if (Number.isFinite(next))
                    setTimelapseTest({ rule: timelapseTest.rule, deviceId: next })
                }}
                data-testid="timelapse-test-camera"
              />
            </div>
          )
        }
        onCancel={() => setTimelapseTest(null)}
        onConfirm={() => {
          if (timelapseTest !== null && timelapseTest.deviceId !== null) {
            testTimelapse.mutate({
              ruleId: timelapseTest.rule.id,
              deviceId: timelapseTest.deviceId,
            })
          }
        }}
      />
    </>
  )

  return {
    summaries,
    timelapses,
    calendarEvents,
    loading: summariesQuery.isLoading || timelapsesQuery.isLoading || calendarQuery.isLoading,
    columnDeps,
    open,
    create,
    notices,
    listFailed,
    overlays,
  }
}

interface OutcomeNoticeProps<T> {
  readonly outcome: T
  readonly onDismiss: () => void
}

function SummaryOutcomeNotice({ outcome, onDismiss }: OutcomeNoticeProps<SummaryTestOutcome>) {
  const { t } = useTranslation()
  return (
    <div
      className="mb-3 rounded-md border border-border px-3 py-2 text-[11px] text-foreground-subtle"
      data-testid="summary-test-outcome"
    >
      {outcome.error !== undefined ? (
        <span className="text-warning">
          {t('system.notificationProducerRules.nothingWasProduced', 'Nothing was produced:')}{' '}
          {outcome.error}
        </span>
      ) : (
        <span>
          {t('system.notificationProducerRules.summaryProduced', {
            digests: t('system.notificationProducerRules.digestCount', { count: outcome.produced }),
            tiles: t('system.notificationProducerRules.tileCount', { count: outcome.tiles ?? 0 }),
            cameras: t('system.notificationProducerRules.cameraCount', {
              count: outcome.cameras ?? 0,
            }),
            matched: t('system.notificationProducerRules.tracksMatched', {
              count: outcome.matched ?? 0,
            }),
            sent: t('system.notificationProducerRules.notificationsSent', {
              count: outcome.enqueued ?? 0,
            }),
          })}
          {/* Said out loud, and only when it happened: a Test that returns two
              tiles out of forty tracks otherwise reads as a quiet window when
              it was in fact a car park. */}
          {(outcome.droppedStationary ?? 0) > 0 && (
            <span data-testid="summary-test-dropped-stationary" className="ml-1">
              {t('system.notificationProducerRules.droppedStationary', {
                count: outcome.droppedStationary,
              })}
            </span>
          )}
        </span>
      )}
      <Button size="sm" variant="ghost" type="button" className="ml-2" onClick={onDismiss}>
        {t('system.notificationProducerRules.dismiss', 'Dismiss')}
      </Button>
    </div>
  )
}

function TimelapseOutcomeNotice({ outcome, onDismiss }: OutcomeNoticeProps<TimelapseTestOutcome>) {
  const { t } = useTranslation()
  return (
    <div
      className="mb-3 rounded-md border border-border px-3 py-2 text-[11px] text-foreground-subtle"
      data-testid="timelapse-test-outcome"
    >
      {outcome.error !== undefined ? (
        <span className="text-warning">
          {t('system.notificationProducerRules.nothingWasProduced', 'Nothing was produced:')}{' '}
          {outcome.error}
        </span>
      ) : (
        <span>
          {t(
            outcome.coveragePercent !== undefined
              ? 'system.notificationProducerRules.timelapseProducedCoverage'
              : 'system.notificationProducerRules.timelapseProduced',
            {
              videos: t('system.notificationProducerRules.videoCount', { count: outcome.produced }),
              percent: Math.round(outcome.coveragePercent ?? 0),
              sent: t('system.notificationProducerRules.notificationsSent', {
                count: outcome.enqueued ?? 0,
              }),
            },
          )}
        </span>
      )}
      <Button size="sm" variant="ghost" type="button" className="ml-2" onClick={onDismiss}>
        {t('system.notificationProducerRules.dismiss', 'Dismiss')}
      </Button>
    </div>
  )
}
