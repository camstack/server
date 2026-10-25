/**
 * Timelapses — the scheduled per-camera video producer, and the surface that
 * creates its rules.
 *
 * The producer has been delivering nightly videos on this hub since 2026-08-10
 * from two rules authored through the API. Nothing in the admin UI could show
 * them, let alone change one — which meant the dense-cadence knobs the operator
 * spent a day tuning were reachable only with `curl`.
 *
 * List chrome matches Rules / Summaries (shared `notification-list-chrome`).
 * Same four data states (rows / empty / unavailable / unreadable) and the same
 * rule about Test: it renders ONE camera's last closed window and DELIVERS it,
 * so it asks first — and it asks WHICH camera, because one rule is several
 * videos.
 */

import type { Target } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import type { DataColumn } from '@camstack/ui-library'
import {
  Badge,
  Button,
  ErrorBox,
  Select,
  Switch,
  useDeviceManagerListAll,
  useSystem,
} from '@camstack/ui-library'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Film, FlaskConical, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { AdminPage } from '../../components/AdminPage'
import { TARGETS_QUERY_KEY } from './NotificationRules'
import { NotificationTimelapseEditor } from './NotificationTimelapseEditor'
import type { DigestCameraOption, DigestTargetOption } from './notification-digest-fields'
import { DigestTestConfirm } from './notification-digest-fields'
import { fleetViewOf } from './device-fleet-view'
import {
  NcListDeleteButton,
  NcListEmpty,
  NcListLoading,
  NcListNameCell,
  NcListRowControls,
  NcListTable,
} from './notification-list-chrome'
import {
  denseCadenceView,
  isTimelapseRuleEditable,
  NC_ADDON_ID,
  NC_DELETE_TIMELAPSE_RULE_ACTION,
  NC_LIST_TIMELAPSE_RULES_ACTION,
  NC_TEST_TIMELAPSE_RULE_ACTION,
  NC_UPSERT_TIMELAPSE_RULE_ACTION,
  parseTimelapseRules,
  parseTimelapseTestOutcome,
  type TimelapseRuleView,
  type TimelapseTestOutcome,
  timelapseLastGeneratedLabel,
  timelapseRuleToForm,
  timelapseScheduleLabel,
} from './notification-timelapse.helpers'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

/** Shared with the Rules strip so the Timelapses tab count and the list never diverge. */
export const TIMELAPSES_QUERY_KEY = ['notificationTimelapses', 'listTimelapseRules'] as const

const SUBTITLE = 'A night of recorded footage, assembled into one short video per camera.'

type EditorState =
  | { readonly mode: 'closed' }
  | { readonly mode: 'form'; readonly rule: TimelapseRuleView | null }

interface TestRequest {
  readonly rule: TimelapseRuleView
  readonly deviceId: number | null
}

export function NotificationTimelapsesPage() {
  const { t } = useTranslation()
  const system = useSystem()
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })
  const [test, setTest] = useState<TestRequest | null>(null)
  const [testOutcome, setTestOutcome] = useState<TimelapseTestOutcome | null>(null)
  const [unreadable, setUnreadable] = useState(false)

  const rulesQuery = useQuery({
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
  useEffect(() => {
    if (rulesQuery.isSuccess) setUnreadable(rulesQuery.data === null)
  }, [rulesQuery.isSuccess, rulesQuery.data])

  /**
   * The shared fleet query — the same hook, input and tRPC key every other
   * fleet reader in this app uses, so the D274 window applies, the
   * `[['deviceManager']]` invalidations reach it, and the cache entry the
   * sidebar search keeps warm serves it with no round-trip. This used to be a
   * raw `trpcClient.deviceManager.listAll.query()` under a private
   * `['deviceManager','listAll','forTimelapses']` key, which matched neither.
   *
   * `slim` is safe BY FIELD: this reads `type`, `id` and `name`. The camera
   * predicate stays `type === Camera` client-side — the server's `isCamera`
   * filter answers a different question and would change which rows appear.
   */
  const fleetQuery = useDeviceManagerListAll({ projection: 'slim' })
  const cameras = useMemo(
    (): readonly DigestCameraOption[] =>
      (fleetQuery.data ?? [])
        .filter((d) => d.type === DeviceType.Camera)
        .map((d) => ({ id: d.id, name: d.name }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    [fleetQuery.data],
  )

  const targetsQuery = useQuery({
    queryKey: TARGETS_QUERY_KEY,
    queryFn: (): Promise<readonly Target[]> =>
      system.trpcClient.notificationOutput.listTargets.query({}),
  })

  const setEnabled = useMutation({
    mutationFn: (vars: { readonly ruleId: string; readonly enabled: boolean }) =>
      system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_UPSERT_TIMELAPSE_RULE_ACTION,
        input: { ruleId: vars.ruleId, patch: { enabled: vars.enabled } },
      }),
    onSuccess: () => void rulesQuery.refetch(),
  })

  const deleteRule = useMutation({
    mutationFn: (ruleId: string) =>
      system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_DELETE_TIMELAPSE_RULE_ACTION,
        input: { ruleId },
      }),
    onSuccess: () => void rulesQuery.refetch(),
  })

  const runTest = useMutation({
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
      setTest(null)
      setTestOutcome(outcome)
    },
  })

  const rules = rulesQuery.data ?? []
  const cameraNameById = new Map(cameras.map((c) => [c.id, c.name]))
  const targetOptions: readonly DigestTargetOption[] = (targetsQuery.data ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    enabled: t.enabled,
  }))
  const targetNameById = new Map(targetOptions.map((t) => [t.id, t.name]))

  const unavailable = rulesQuery.isError || rulesQuery.data === null
  const openEditor = (rule: TimelapseRuleView): void => {
    if (isTimelapseRuleEditable(rule)) setEditor({ mode: 'form', rule })
  }

  const body = (
    <>
      {rulesQuery.isLoading && <NcListLoading />}

      {unavailable && !rulesQuery.isLoading && (
        <ErrorBox
          title={t(
            'system.notificationTimelapses.timelapseRulesAreNotAvailable',
            'Timelapse rules are not available on this hub',
          )}
          message={
            unreadable
              ? t(
                  'system.notificationTimelapses.theHubAnsweredSomethingThis',
                  'The hub answered something this admin build does not understand. Update both and reload.',
                )
              : t(
                  'system.notificationTimelapses.thisHubHasNotBeen',
                  'This hub has not been updated to serve timelapse rules yet. Deploy addon-post-analysis and reload — the rules themselves are untouched.',
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
                'system.notificationTimelapses.couldNotDeleteTheRule',
                'Could not delete the rule',
              )}
              message={String(deleteRule.error)}
            />
          )}
          {runTest.isError && (
            <ErrorBox
              title={t('system.notificationTimelapses.theTestRunFailed', 'The test run failed')}
              message={String(runTest.error)}
            />
          )}

          {testOutcome !== null && (
            <div
              className="mb-3 rounded-md border border-border px-3 py-2 text-[11px] text-foreground-subtle"
              data-testid="timelapse-test-outcome"
            >
              {testOutcome.error !== undefined ? (
                <span className="text-warning">
                  {t('system.notificationTimelapses.nothingWasProduced', 'Nothing was produced:')}{' '}
                  {testOutcome.error}
                </span>
              ) : (
                <span>
                  {t(
                    testOutcome.coveragePercent !== undefined
                      ? 'system.notificationProducerRules.timelapseProducedCoverage'
                      : 'system.notificationProducerRules.timelapseProduced',
                    {
                      videos: t('system.notificationProducerRules.videoCount', {
                        count: testOutcome.produced,
                      }),
                      percent: Math.round(testOutcome.coveragePercent ?? 0),
                      sent: t('system.notificationProducerRules.notificationsSent', {
                        count: testOutcome.enqueued ?? 0,
                      }),
                    },
                  )}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                type="button"
                className="ml-2"
                onClick={() => setTestOutcome(null)}
              >
                {t('system.notificationTimelapses.dismiss', 'Dismiss')}
              </Button>
            </div>
          )}

          {rules.length === 0 ? (
            <NcListEmpty testId="timelapse-empty">
              {t(
                'system.notificationTimelapses.noTimelapseRulesYetCreate',
                "No timelapse rules yet — create one, and each night's recorded footage arrives as a short video.",
              )}
            </NcListEmpty>
          ) : (
            <NcListTable<TimelapseRuleView>
              columns={timelapseColumns({
                nowMs: Date.now(),
                cameraNameById,
                targetNameById,
                deletePending: deleteRule.isPending,
                onToggle: (rule, enabled) => setEnabled.mutate({ ruleId: rule.id, enabled }),
                onOpen: openEditor,
                onTest: (rule) => setTest({ rule, deviceId: rule.deviceIds[0] ?? null }),
                onConfirmDelete: (rule) => deleteRule.mutate(rule.id),
              })}
              rows={rules}
              rowKey={(r) => r.id}
              minWidthPx={900}
              onRowClick={openEditor}
            />
          )}
        </>
      )}

      {editor.mode === 'form' && (
        <NotificationTimelapseEditor
          rule={editor.rule}
          cameras={cameras}
          fleet={fleetViewOf(fleetQuery)}
          targets={targetOptions}
          onCancel={() => setEditor({ mode: 'closed' })}
          onSaved={() => {
            setEditor({ mode: 'closed' })
            void rulesQuery.refetch()
          }}
        />
      )}

      <DigestTestConfirm
        open={test !== null}
        ruleName={test?.rule.name ?? ''}
        windowDescription="its last closed window"
        targetDescription={`${test?.rule.targets.length ?? 0} target${
          (test?.rule.targets.length ?? 0) === 1 ? '' : 's'
        }`}
        pending={runTest.isPending}
        confirmDisabled={test?.deviceId === null}
        extra={
          test === null ? null : (
            <div>
              {/* One rule is SEVERAL videos: the action renders exactly one
                  camera, so the choice is explicit rather than "the first". */}
              <label className="mb-1 block text-[11px] font-medium text-foreground">
                {t('system.notificationTimelapses.whichCamera', 'Which camera')}
              </label>
              <Select
                value={test.deviceId === null ? '' : String(test.deviceId)}
                options={test.rule.deviceIds.map((id) => ({
                  value: String(id),
                  label: cameraNameById.get(id) ?? `#${id}`,
                }))}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  if (Number.isFinite(next)) setTest({ rule: test.rule, deviceId: next })
                }}
                data-testid="timelapse-test-camera"
              />
            </div>
          )
        }
        onCancel={() => setTest(null)}
        onConfirm={() => {
          if (test !== null && test.deviceId !== null) {
            runTest.mutate({ ruleId: test.rule.id, deviceId: test.deviceId })
          }
        }}
      />
    </>
  )

  return (
    <AdminPage
      icon={Film}
      title={t('system.notificationTimelapses.timelapses', 'Timelapses')}
      subtitle={SUBTITLE}
      actions={
        !unavailable ? (
          <Button
            size="sm"
            type="button"
            onClick={() => setEditor({ mode: 'form', rule: null })}
            data-testid="timelapse-new"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('system.notificationTimelapses.newTimelapse', 'New timelapse')}
          </Button>
        ) : undefined
      }
    >
      {body}
    </AdminPage>
  )
}

export interface TimelapseColumnsDeps {
  readonly nowMs: number
  readonly cameraNameById: ReadonlyMap<number, string>
  readonly targetNameById: ReadonlyMap<string, string>
  readonly deletePending: boolean
  readonly onToggle: (rule: TimelapseRuleView, enabled: boolean) => void
  readonly onOpen: (rule: TimelapseRuleView) => void
  readonly onTest: (rule: TimelapseRuleView) => void
  readonly onConfirmDelete: (rule: TimelapseRuleView) => void
}

export function timelapseColumns(
  deps: TimelapseColumnsDeps,
): readonly DataColumn<TimelapseRuleView>[] {
  return [
    {
      key: 'name',
      header: i18n.t('system.notificationTimelapses.timelapse', 'Timelapse'),
      render: (rule) => (
        <NcListNameCell
          name={rule.name}
          enabled={rule.enabled}
          {...(isTimelapseRuleEditable(rule)
            ? { onOpen: () => deps.onOpen(rule), openTestId: `timelapse-edit-${rule.id}` }
            : {})}
          badges={
            !isTimelapseRuleEditable(rule) ? <Badge variant="warning">read-only</Badge> : null
          }
        />
      ),
    },
    {
      key: 'cameras',
      header: i18n.t('system.notificationTimelapses.cameras', 'Cameras'),
      render: (rule) => (
        <span className="text-[11px] text-foreground-subtle">
          {rule.deviceIds.length === 1
            ? (deps.cameraNameById.get(rule.deviceIds[0] ?? -1) ?? `#${rule.deviceIds[0]}`)
            : i18n.t('system.notificationTimelapses.cameras2', '{{length}} cameras', {
                length: rule.deviceIds.length,
              })}
        </span>
      ),
    },
    {
      key: 'schedule',
      header: i18n.t('system.notificationTimelapses.window', 'Window'),
      render: (rule) => (
        <span className="text-[11px] text-foreground-subtle">
          {timelapseScheduleLabel(rule.schedule)}
        </span>
      ),
    },
    {
      key: 'sampling',
      header: i18n.t('system.notificationTimelapses.sampling', 'Sampling'),
      nowrap: true,
      render: (rule) => {
        // The dense cadence is what the operator tunes, and on both live rules
        // it is DERIVED — printing only the base would hide the number he is
        // actually looking for.
        const dense = denseCadenceView(timelapseRuleToForm(rule))
        return (
          <span className="text-[11px] text-foreground-subtle">
            {i18n.t(
              dense.derived
                ? 'system.notificationTimelapses.ruleSummaryAuto'
                : 'system.notificationTimelapses.ruleSummary',
              { cadence: rule.cadenceSec, fps: rule.framerate, dense: dense.seconds },
            )}
            {rule.minDwellSec !== undefined
              ? ` · ${i18n.t('system.notificationTimelapses.ruleDwell', { sec: rule.minDwellSec })}`
              : ''}
          </span>
        )
      },
    },
    {
      key: 'targets',
      header: i18n.t('system.notificationTimelapses.targets', 'Targets'),
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
      header: i18n.t('system.notificationTimelapses.lastRun', 'Last run'),
      nowrap: true,
      render: (rule) => (
        <span
          className="text-[11px] text-foreground-subtle"
          data-testid={`timelapse-last-${rule.id}`}
        >
          {timelapseLastGeneratedLabel(rule.lastGeneratedAt, deps.nowMs)}
        </span>
      ),
    },
    {
      key: 'enabled',
      header: i18n.t('system.notificationTimelapses.on', 'On'),
      align: 'center',
      nowrap: true,
      render: (rule) => (
        <NcListRowControls>
          <Switch
            checked={rule.enabled}
            disabled={!isTimelapseRuleEditable(rule)}
            onCheckedChange={(next) => deps.onToggle(rule, next)}
            aria-label={i18n.t('system.notificationTimelapses.toggle', 'toggle {{name}}', {
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
          <Button
            size="sm"
            variant="ghost"
            type="button"
            disabled={!isTimelapseRuleEditable(rule)}
            onClick={() => deps.onTest(rule)}
            title={i18n.t(
              'system.notificationTimelapses.renderThisRuleSLast',
              "Render this rule's last closed window now and DELIVER it",
            )}
            aria-label={i18n.t('system.notificationTimelapses.test', 'test {{name}}', {
              name: rule.name,
            })}
            data-testid={`timelapse-test-${rule.id}`}
          >
            <FlaskConical className="h-3.5 w-3.5" />
          </Button>
          {/* No Edit button: the row IS the edit target (same as Rules). */}
          <NcListDeleteButton
            disabled={!isTimelapseRuleEditable(rule)}
            pending={deps.deletePending}
            title={i18n.t(
              'system.notificationTimelapses.deleteThisTimelapse',
              'Delete this timelapse?',
            )}
            message={i18n.t(
              'system.notificationTimelapses.thisWillPermanentlyDeleteThis',
              'This will permanently delete "{{name}}". This action cannot be undone.',
              { name: rule.name },
            )}
            ariaLabel={i18n.t('system.notificationTimelapses.delete', 'delete {{name}}', {
              name: rule.name,
            })}
            testId={`timelapse-delete-${rule.id}`}
            onConfirm={() => deps.onConfirmDelete(rule)}
          />
        </NcListRowControls>
      ),
    },
  ]
}

export default NotificationTimelapsesPage
