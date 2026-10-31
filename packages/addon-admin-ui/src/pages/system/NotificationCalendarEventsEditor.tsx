/**
 * Calendar-events rule editor — create/edit dialog with the same tabbed chrome
 * as Summaries / Timelapses.
 */

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  Input,
  useCalendarsListCalendars,
  useSystem,
  Textarea,
} from '@camstack/ui-library'
import { useMutation } from '@tanstack/react-query'
import { Calendar as CalendarIcon, Loader2 } from 'lucide-react'
import { useState } from 'react'
import {
  DigestNumberField,
  DigestSection,
  DigestSwitchField,
  DigestTargetsField,
  type DigestTargetOption,
} from './notification-digest-fields'
import { ScheduleField } from './notification-schedule-field'
import { DevicePicker } from './DevicePicker'
import { RuleScopeField } from './RuleScopeField'
import { projectRuleScope, ruleScopeDraftOf, type RuleScopeDraft } from './rule-scope-model'
import {
  buildCalendarEventsCreateInput,
  buildCalendarEventsPatch,
  CALENDAR_EVENTS_MAX_HORIZON_DAYS,
  CALENDAR_EVENTS_MIN_HORIZON_DAYS,
  calendarEventsRuleToForm,
  type CalendarEventsFormState,
  type CalendarEventsRuleView,
  type CalendarEventsTabKey,
  DEFAULT_CALENDAR_EVENTS_TAB,
  emptyCalendarEventsForm,
  isCalendarEventsFormValid,
  NC_ADDON_ID,
  NC_CALENDAR_EVENTS_TABS,
  NC_UPSERT_CALENDAR_EVENTS_RULE_ACTION,
} from './notification-calendar-events.helpers'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

export interface NotificationCalendarEventsEditorProps {
  readonly rule: CalendarEventsRuleView | null
  readonly targets: readonly DigestTargetOption[]
  readonly onSaved: () => void
  readonly onCancel: () => void
}

export function NotificationCalendarEventsEditor({
  rule,
  targets,
  onSaved,
  onCancel,
}: NotificationCalendarEventsEditorProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const calendarsQuery = useCalendarsListCalendars()
  const [form, setForm] = useState<CalendarEventsFormState>(() =>
    rule === null ? emptyCalendarEventsForm() : calendarEventsRuleToForm(rule),
  )
  const [scope, setScope] = useState<RuleScopeDraft<string>>(() =>
    ruleScopeDraftOf(
      rule === null ? undefined : rule.calendars,
      rule === null ? undefined : rule.calendarsExclude,
    ),
  )
  const [tab, setTab] = useState<CalendarEventsTabKey>(DEFAULT_CALENDAR_EVENTS_TAB)
  const [error, setError] = useState<string | null>(null)

  const patch = (next: Partial<CalendarEventsFormState>): void =>
    setForm((prev) => ({ ...prev, ...next }))

  const save = useMutation({
    mutationFn: async () => {
      const scoped = projectRuleScope(scope)
      const withScope: CalendarEventsFormState = {
        ...form,
        calendars: scoped.include ?? [],
        calendarsExclude: scoped.exclude ?? [],
      }
      if (!isCalendarEventsFormValid(withScope)) {
        throw new Error('Name, at least one target, and a schedule are required')
      }
      const input =
        rule === null
          ? { rule: buildCalendarEventsCreateInput(withScope) }
          : {
              ruleId: rule.id,
              patch: buildCalendarEventsPatch(withScope, rule),
            }
      await system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_UPSERT_CALENDAR_EVENTS_RULE_ACTION,
        input,
      })
    },
    onSuccess: () => onSaved(),
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    },
  })

  const calendarItems = (calendarsQuery.data ?? []).map((c) => ({ id: c.id, name: c.name }))

  return (
    <Dialog open onOpenChange={(next) => !next && onCancel()}>
      <DialogContent
        width="lg"
        placement="sheet-on-mobile"
        scroll="body"
        data-testid="calendar-events-editor"
      >
        <div className="mb-3 flex shrink-0 items-center justify-between gap-2 pr-10">
          <div className="flex min-w-0 items-center gap-2">
            <CalendarIcon className="h-4 w-4 shrink-0 text-foreground-subtle" />
            <h3 className="truncate text-sm font-semibold text-foreground">
              {rule === null
                ? t(
                    'system.notificationCalendarEventsEditor.newCalendarEvents',
                    'New calendar events',
                  )
                : form.name}
            </h3>
          </div>
          <Button
            size="sm"
            type="button"
            disabled={save.isPending}
            onClick={() => {
              setError(null)
              void save.mutateAsync()
            }}
            data-testid="calendar-events-save"
          >
            {save.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              t('common.save', 'Save')
            )}
          </Button>
        </div>

        <Tabs
          value={tab}
          onValueChange={(next) => {
            const hit = NC_CALENDAR_EVENTS_TABS.find((t) => t.key === next)
            if (hit !== undefined) setTab(hit.key)
          }}
        >
          <TabsList className="mb-3">
            {NC_CALENDAR_EVENTS_TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <DialogBody className="space-y-4 pr-1">
            {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}

            <TabsContent value="basics" className="space-y-3">
              <DigestSection title={t('system.notificationCalendarEventsEditor.basics', 'Basics')}>
                <label className="block text-sm">
                  {t('system.notificationCalendarEventsEditor.name', 'Name')}
                  <Input
                    className="mt-1"
                    value={form.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    data-testid="calendar-events-name"
                  />
                </label>
                <DigestNumberField
                  label={t('system.notificationCalendarEventsEditor.horizonDays', 'Horizon (days)')}
                  value={form.horizonDays}
                  min={CALENDAR_EVENTS_MIN_HORIZON_DAYS}
                  max={CALENDAR_EVENTS_MAX_HORIZON_DAYS}
                  onChange={(horizonDays) => {
                    if (horizonDays !== undefined) patch({ horizonDays })
                  }}
                />
                <DigestNumberField
                  label={t('system.notificationCalendarEventsEditor.priority', 'Priority')}
                  value={form.priority}
                  min={1}
                  max={5}
                  onChange={(priority) => {
                    if (priority !== undefined) patch({ priority })
                  }}
                />
                <DigestSwitchField
                  label={t('system.notificationCalendarEventsEditor.enabled', 'Enabled')}
                  checked={form.enabled}
                  onChange={(enabled) => patch({ enabled })}
                />
                <DigestSwitchField
                  label={t(
                    'system.notificationCalendarEventsEditor.deliverWhenEmpty',
                    'Deliver when empty',
                  )}
                  checked={form.deliverEmpty}
                  onChange={(deliverEmpty) => patch({ deliverEmpty })}
                />
              </DigestSection>
            </TabsContent>

            <TabsContent value="schedule" className="space-y-3">
              <DigestSection
                title={t('system.notificationCalendarEventsEditor.schedule', 'Schedule')}
              >
                <ScheduleField
                  mode="times"
                  value={form.schedule}
                  onChange={(schedule) => patch({ schedule })}
                />
                <p className="text-[11px] text-foreground-subtle">
                  {t(
                    'system.notificationCalendarEventsEditor.oneSendTimePerRow',
                    'One send time per row. The digest fires at that minute.',
                  )}
                </p>
              </DigestSection>
            </TabsContent>

            <TabsContent value="calendars" className="space-y-3">
              <DigestSection
                title={t('system.notificationCalendarEventsEditor.calendars', 'Calendars')}
              >
                <RuleScopeField
                  draft={scope}
                  onChange={setScope}
                  exceptOffered
                  plural="calendars"
                  describe={(id) => calendarItems.find((c) => c.id === id)?.name ?? id}
                  testId="calendar-events-scope"
                  renderPicker={(value, change, mode) => (
                    <DevicePicker<string>
                      key={mode}
                      devices={calendarItems}
                      listState={calendarsQuery.isPending ? 'pending' : 'answered'}
                      value={value}
                      onChange={change}
                      emptyMeansAll
                      noun="calendar"
                      testId="calendar-picker"
                    />
                  )}
                />
              </DigestSection>
            </TabsContent>

            <TabsContent value="targets" className="space-y-3">
              <DigestSection
                title={t('system.notificationCalendarEventsEditor.targets', 'Targets')}
              >
                <DigestTargetsField
                  targets={targets}
                  value={form.targetIds}
                  onChange={(targetIds) => patch({ targetIds })}
                />
              </DigestSection>
            </TabsContent>

            <TabsContent value="template" className="space-y-3">
              <DigestSection
                title={t('system.notificationCalendarEventsEditor.template', 'Template')}
              >
                <p className="text-[11px] text-foreground-subtle">
                  {t(
                    'system.notificationCalendarEventsEditor.optionalLeaveBlankForThe',
                    'Optional. Leave blank for the default digest body (tomorrow highlighted, then later days). Variables:',
                  )}{' '}
                  {t('system.notificationCalendarEventsEditor.templateVars', {
                    ruleVar: '{{rule}}',
                    countVar: '{{count}}',
                    horizonVar: '{{horizonDays}}',
                    eventsVar: '{{events}}',
                  })}
                </p>
                <label className="block text-sm">
                  {t('system.notificationCalendarEventsEditor.title', 'Title')}
                  <Input
                    className="mt-1"
                    value={form.templateTitle}
                    onChange={(e) => patch({ templateTitle: e.target.value })}
                  />
                </label>
                <label className="block text-sm">
                  {t('system.notificationCalendarEventsEditor.body', 'Body')}
                  <Textarea
                    className="mt-1 min-h-[8rem] w-full rounded border border-border bg-background px-2 py-1 text-xs"
                    value={form.templateBody}
                    onChange={(e) => patch({ templateBody: e.target.value })}
                  />
                </label>
              </DigestSection>
            </TabsContent>
          </DialogBody>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
