/**
 * Calendar-events rules — standalone list page (same chrome as Summaries /
 * Timelapses) plus the column builder the unified Rules table reuses.
 */
import type { Target } from '@camstack/types'
import type { DataColumn } from '@camstack/ui-library'
import { Badge, Button, ErrorBox, Switch, useSystem } from '@camstack/ui-library'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Calendar as CalendarIcon, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { AdminPage } from '../../components/AdminPage'
import { TARGETS_QUERY_KEY } from './NotificationRules'
import { NotificationCalendarEventsEditor } from './NotificationCalendarEventsEditor'
import type { DigestTargetOption } from './notification-digest-fields'
import {
  NcListDeleteButton,
  NcListEmpty,
  NcListLoading,
  NcListNameCell,
  NcListRowControls,
  NcListTable,
} from './notification-list-chrome'
import {
  CALENDAR_EVENTS_QUERY_KEY,
  calendarHorizonLabel,
  calendarScheduleLabel,
  calendarScopeLabel,
  isEditableCalendarEventsRule,
  NC_ADDON_ID,
  NC_DELETE_CALENDAR_EVENTS_RULE_ACTION,
  NC_LIST_CALENDAR_EVENTS_RULES_ACTION,
  NC_UPSERT_CALENDAR_EVENTS_RULE_ACTION,
  parseCalendarEventsRules,
  type CalendarEventsRuleView,
} from './notification-calendar-events.helpers'
import { summaryLastGeneratedLabel } from './notification-summaries.helpers'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

const SUBTITLE =
  'At schedule time, send the upcoming events from selected calendars for the next N days.'

type EditorState =
  | { readonly mode: 'closed' }
  | { readonly mode: 'form'; readonly rule: CalendarEventsRuleView | null }

export function NotificationCalendarEventsPage() {
  const { t } = useTranslation()
  const system = useSystem()
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })
  const [unreadable, setUnreadable] = useState(false)

  const rulesQuery = useQuery({
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
  useEffect(() => {
    if (rulesQuery.isSuccess) setUnreadable(rulesQuery.data === null)
  }, [rulesQuery.isSuccess, rulesQuery.data])

  const targetsQuery = useQuery({
    queryKey: TARGETS_QUERY_KEY,
    queryFn: (): Promise<readonly Target[]> =>
      system.trpcClient.notificationOutput.listTargets.query({}),
  })

  const setEnabled = useMutation({
    mutationFn: (vars: { readonly ruleId: string; readonly enabled: boolean }) =>
      system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_UPSERT_CALENDAR_EVENTS_RULE_ACTION,
        input: { ruleId: vars.ruleId, patch: { enabled: vars.enabled } },
      }),
    onSuccess: () => void rulesQuery.refetch(),
  })

  const deleteRule = useMutation({
    mutationFn: (ruleId: string) =>
      system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_DELETE_CALENDAR_EVENTS_RULE_ACTION,
        input: { ruleId },
      }),
    onSuccess: () => void rulesQuery.refetch(),
  })

  const rules = rulesQuery.data ?? []
  const targetOptions: readonly DigestTargetOption[] = (targetsQuery.data ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    enabled: t.enabled,
  }))
  const targetNameById = new Map(targetOptions.map((t) => [t.id, t.name]))
  const unavailable = rulesQuery.isError || rulesQuery.data === null
  const openEditor = (rule: CalendarEventsRuleView): void => {
    if (isEditableCalendarEventsRule(rule)) setEditor({ mode: 'form', rule })
  }

  const body = (
    <>
      {rulesQuery.isLoading && <NcListLoading />}

      {unavailable && !rulesQuery.isLoading && (
        <ErrorBox
          title={t(
            'system.notificationCalendarEventsPage.calendarEventsRulesAreNot',
            'Calendar-events rules are not available on this hub',
          )}
          message={
            unreadable
              ? t(
                  'system.notificationCalendarEventsPage.theHubAnsweredSomethingThis',
                  'The hub answered something this admin build does not understand. Update both and reload.',
                )
              : t(
                  'system.notificationCalendarEventsPage.thisHubHasNotBeen',
                  'This hub has not been updated to serve calendar-events rules yet. Deploy addon-post-analysis and reload — the rules themselves are untouched.',
                )
          }
          onRetry={() => void rulesQuery.refetch()}
        />
      )}

      {!rulesQuery.isLoading && !unavailable && (
        <>
          {deleteRule.isError && (
            <ErrorBox
              title={t(
                'system.notificationCalendarEventsPage.couldNotDeleteTheRule',
                'Could not delete the rule',
              )}
              message={String(deleteRule.error)}
            />
          )}

          {rules.length === 0 ? (
            <NcListEmpty testId="calendar-events-empty">
              {t(
                'system.notificationCalendarEventsPage.noCalendarEventsRulesYet',
                'No calendar-events rules yet — create one, and upcoming calendar events arrive on schedule.',
              )}
            </NcListEmpty>
          ) : (
            <NcListTable<CalendarEventsRuleView>
              columns={calendarEventsColumns({
                nowMs: Date.now(),
                targetNameById,
                deletePending: deleteRule.isPending,
                onToggle: (rule, enabled) => setEnabled.mutate({ ruleId: rule.id, enabled }),
                onOpen: openEditor,
                onConfirmDelete: (rule) => deleteRule.mutate(rule.id),
              })}
              rows={rules}
              rowKey={(r) => r.id}
              minWidthPx={860}
              onRowClick={openEditor}
            />
          )}
        </>
      )}

      {editor.mode === 'form' && (
        <NotificationCalendarEventsEditor
          rule={editor.rule}
          targets={targetOptions}
          onCancel={() => setEditor({ mode: 'closed' })}
          onSaved={() => {
            setEditor({ mode: 'closed' })
            void rulesQuery.refetch()
          }}
        />
      )}
    </>
  )

  return (
    <AdminPage
      icon={CalendarIcon}
      title={t('system.notificationCalendarEventsPage.calendarEvents', 'Calendar events')}
      subtitle={SUBTITLE}
      actions={
        !unavailable ? (
          <Button
            size="sm"
            type="button"
            onClick={() => setEditor({ mode: 'form', rule: null })}
            data-testid="calendar-events-new"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('system.notificationCalendarEventsPage.newCalendarEvents', 'New calendar events')}
          </Button>
        ) : undefined
      }
    >
      {body}
    </AdminPage>
  )
}

export interface CalendarEventsColumnsDeps {
  readonly nowMs: number
  readonly targetNameById: ReadonlyMap<string, string>
  readonly deletePending: boolean
  readonly onToggle: (rule: CalendarEventsRuleView, enabled: boolean) => void
  readonly onOpen: (rule: CalendarEventsRuleView) => void
  readonly onConfirmDelete: (rule: CalendarEventsRuleView) => void
}

export function calendarEventsColumns(
  deps: CalendarEventsColumnsDeps,
): readonly DataColumn<CalendarEventsRuleView>[] {
  return [
    {
      key: 'name',
      header: i18n.t('system.notificationCalendarEventsPage.rule', 'Rule'),
      render: (rule) => (
        <NcListNameCell
          name={rule.name}
          enabled={rule.enabled}
          {...(isEditableCalendarEventsRule(rule) ? { onOpen: () => deps.onOpen(rule) } : {})}
          openTestId={`calendar-events-edit-${rule.id}`}
          badges={
            !isEditableCalendarEventsRule(rule) ? <Badge variant="warning">read-only</Badge> : null
          }
        />
      ),
    },
    {
      key: 'schedule',
      header: i18n.t('system.notificationCalendarEventsPage.when', 'When'),
      render: (rule) => (
        <span className="text-[11px] text-foreground-subtle">
          {calendarScheduleLabel(rule.schedule)}
        </span>
      ),
    },
    {
      key: 'horizon',
      header: i18n.t('system.notificationCalendarEventsPage.horizon', 'Horizon'),
      nowrap: true,
      render: (rule) => (
        <span className="text-[11px] text-foreground-subtle">
          {calendarHorizonLabel(rule.horizonDays)}
        </span>
      ),
    },
    {
      key: 'calendars',
      header: i18n.t('system.notificationCalendarEventsPage.calendars', 'Calendars'),
      render: (rule) => (
        <span className="text-[11px] text-foreground-subtle">{calendarScopeLabel(rule)}</span>
      ),
    },
    {
      key: 'targets',
      header: i18n.t('system.notificationCalendarEventsPage.targets', 'Targets'),
      render: (rule) => {
        const first = rule.targets[0]
        const name = first ? (deps.targetNameById.get(first.targetId) ?? first.targetId) : null
        return (
          <span className="text-[11px] text-foreground-subtle">
            {rule.targets.length === 1 && name !== null
              ? name
              : i18n.t('common.targetCount', { count: rule.targets.length })}
          </span>
        )
      },
    },
    {
      key: 'lastRun',
      header: i18n.t('system.notificationCalendarEventsPage.lastRun', 'Last run'),
      nowrap: true,
      render: (rule) => (
        <span
          className="text-[11px] text-foreground-subtle"
          data-testid={`calendar-events-last-${rule.id}`}
        >
          {summaryLastGeneratedLabel(rule.generatedAt, deps.nowMs)}
        </span>
      ),
    },
    {
      key: 'enabled',
      header: i18n.t('system.notificationCalendarEventsPage.on', 'On'),
      align: 'center',
      nowrap: true,
      render: (rule) => (
        <NcListRowControls>
          <Switch
            checked={rule.enabled}
            disabled={rule.readOnly}
            onCheckedChange={(next) => deps.onToggle(rule, next)}
            aria-label={i18n.t('system.notificationCalendarEventsPage.toggle', 'toggle {{name}}', {
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
      render: (rule) => (
        <NcListRowControls className="flex items-center justify-end gap-1">
          <NcListDeleteButton
            disabled={rule.readOnly}
            pending={deps.deletePending}
            title={i18n.t(
              'system.notificationCalendarEventsPage.deleteThisCalendarEventsRule',
              'Delete this calendar-events rule?',
            )}
            message={i18n.t(
              'system.notificationCalendarEventsPage.thisWillPermanentlyDeleteThis',
              'This will permanently delete "{{name}}". This action cannot be undone.',
              { name: rule.name },
            )}
            ariaLabel={i18n.t('system.notificationCalendarEventsPage.delete', 'delete {{name}}', {
              name: rule.name,
            })}
            testId={`calendar-events-delete-${rule.id}`}
            onConfirm={() => deps.onConfirmDelete(rule)}
          />
        </NcListRowControls>
      ),
    },
  ]
}

export default NotificationCalendarEventsPage
