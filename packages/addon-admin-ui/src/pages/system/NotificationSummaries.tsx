/**
 * Summaries — the multi-camera DIGEST rules, and the surface that creates them.
 *
 * The producer, the mosaic renderer, the motion window, the track-close barrier
 * and the four `nc.*SummaryRule*` bridge actions all shipped complete; there was
 * no way to author a rule except the API. This tab is that way.
 *
 * List chrome matches Rules (shared `notification-list-chrome`): AdminPage +
 * loading / empty / Card+DataTable, row opens the editor, delete asks through
 * `useConfirm`. Four data states stay distinct:
 *   - ROWS        → the rules.
 *   - EMPTY       → the hub answered, and it holds no rule.
 *   - UNAVAILABLE → `nc.listSummaryRules` ERRORED (hub predates the feature).
 *   - UNREADABLE  → it answered a shape this bundle cannot narrow.
 *
 * The Test button DELIVERS. It runs the real producer over an explicit recent
 * window down to the real outbox, so it sits behind a confirm that names the
 * window and the recipients.
 */

import type { NcTaxonomy, Target } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import type { DataColumn } from '@camstack/ui-library'
import {
  Badge,
  Button,
  ErrorBox,
  Switch,
  useDeviceManagerListAll,
  useSystem,
} from '@camstack/ui-library'
import { useMutation, useQuery } from '@tanstack/react-query'
import { FlaskConical, Images, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { AdminPage } from '../../components/AdminPage'
import { CATALOG_QUERY_KEY, TARGETS_QUERY_KEY } from './NotificationRules'
import { NotificationSummaryEditor } from './NotificationSummaryEditor'
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
  summaryFilterLabel,
  summaryLastGeneratedLabel,
  summaryTestWindow,
  summaryWindowLabel,
} from './notification-summaries.helpers'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

/** Shared with the Rules strip so the Summaries tab count and the list never diverge. */
export const SUMMARIES_QUERY_KEY = ['notificationSummaries', 'listSummaryRules'] as const

const SUBTITLE = 'One window, one picture: every camera’s best moments as a single mosaic.'

interface CatalogAnswer {
  readonly taxonomy?: NcTaxonomy
}

type EditorState =
  | { readonly mode: 'closed' }
  | { readonly mode: 'form'; readonly rule: SummaryEditableRule | null }

export function NotificationSummariesPage() {
  const { t } = useTranslation()
  const system = useSystem()
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })
  const [testRule, setTestRule] = useState<SummaryRuleView | null>(null)
  const [testOutcome, setTestOutcome] = useState<SummaryTestOutcome | null>(null)
  const [unreadable, setUnreadable] = useState(false)

  const rulesQuery = useQuery({
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
  useEffect(() => {
    if (rulesQuery.isSuccess) setUnreadable(rulesQuery.data === null)
  }, [rulesQuery.isSuccess, rulesQuery.data])

  /**
   * The shared fleet query — the same hook, input and tRPC key every other
   * fleet reader in this app uses, so the D274 window applies, the
   * `[['deviceManager']]` invalidations reach it, and the cache entry the
   * sidebar search keeps warm serves it with no round-trip. This used to be a
   * raw `trpcClient.deviceManager.listAll.query()` under a private
   * `['deviceManager','listAll','forSummaries']` key, which matched neither.
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

  // The SAME keys the rules page uses: the targets and the taxonomy are the
  // same answers, and two keys for one question means the operator pays for the
  // round-trip twice and can see two vocabularies on two tabs of one page.
  const targetsQuery = useQuery({
    queryKey: TARGETS_QUERY_KEY,
    queryFn: (): Promise<readonly Target[]> =>
      system.trpcClient.notificationOutput.listTargets.query({}),
  })

  const catalogQuery = useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: (): Promise<CatalogAnswer> =>
      system.trpcClient.notificationRules.getConditionCatalog.query({}),
  })

  const setEnabled = useMutation({
    mutationFn: (vars: { readonly ruleId: string; readonly enabled: boolean }) =>
      system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_UPSERT_SUMMARY_RULE_ACTION,
        input: { ruleId: vars.ruleId, patch: { enabled: vars.enabled } },
      }),
    onSuccess: () => void rulesQuery.refetch(),
  })

  const deleteRule = useMutation({
    mutationFn: (ruleId: string) =>
      system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_DELETE_SUMMARY_RULE_ACTION,
        input: { ruleId },
      }),
    onSuccess: () => void rulesQuery.refetch(),
  })

  const runTest = useMutation({
    mutationFn: async (ruleId: string): Promise<SummaryTestOutcome | null> => {
      const raw = await system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_TEST_SUMMARY_RULE_ACTION,
        // An EXPLICIT window: a motion rule that has seen nothing has no window
        // of its own, and "no window has closed recently" tests nothing the
        // operator asked about.
        input: { ruleId, ...summaryTestWindow(Date.now()) },
      })
      return parseSummaryTestOutcome(raw)
    },
    onSuccess: (outcome) => {
      setTestRule(null)
      setTestOutcome(outcome)
    },
  })

  const rules = rulesQuery.data ?? []
  const targetOptions: readonly DigestTargetOption[] = (targetsQuery.data ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    enabled: t.enabled,
  }))
  const targetNameById = new Map(targetOptions.map((t) => [t.id, t.name]))

  const unavailable = rulesQuery.isError || rulesQuery.data === null
  const openEditor = (rule: SummaryRuleView): void => {
    if (isEditableSummaryRule(rule)) setEditor({ mode: 'form', rule })
  }

  const body = (
    <>
      {rulesQuery.isLoading && <NcListLoading />}

      {unavailable && !rulesQuery.isLoading && (
        <ErrorBox
          title={t(
            'system.notificationSummaries.summaryRulesAreNotAvailable',
            'Summary rules are not available on this hub',
          )}
          message={
            unreadable
              ? t(
                  'system.notificationSummaries.theHubAnsweredSomethingThis',
                  'The hub answered something this admin build does not understand. Update both and reload.',
                )
              : t(
                  'system.notificationSummaries.thisHubHasNotBeen',
                  'This hub has not been updated to serve summary rules yet. Deploy addon-post-analysis and reload — nothing is lost in the meantime.',
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
                'system.notificationSummaries.couldNotDeleteTheRule',
                'Could not delete the rule',
              )}
              message={String(deleteRule.error)}
            />
          )}
          {runTest.isError && (
            <ErrorBox
              title={t('system.notificationSummaries.theTestRunFailed', 'The test run failed')}
              message={String(runTest.error)}
            />
          )}

          {testOutcome !== null && (
            <div
              className="mb-3 rounded-md border border-border px-3 py-2 text-[11px] text-foreground-subtle"
              data-testid="summary-test-outcome"
            >
              {testOutcome.error !== undefined ? (
                <span className="text-warning">
                  {t('system.notificationSummaries.nothingWasProduced', 'Nothing was produced:')}{' '}
                  {testOutcome.error}
                </span>
              ) : (
                <span>
                  {t('system.notificationProducerRules.summaryProduced', {
                    digests: t('system.notificationProducerRules.digestCount', {
                      count: testOutcome.produced,
                    }),
                    tiles: t('system.notificationProducerRules.tileCount', {
                      count: testOutcome.tiles ?? 0,
                    }),
                    cameras: t('system.notificationProducerRules.cameraCount', {
                      count: testOutcome.cameras ?? 0,
                    }),
                    matched: t('system.notificationProducerRules.tracksMatched', {
                      count: testOutcome.matched ?? 0,
                    }),
                    sent: t('system.notificationProducerRules.notificationsSent', {
                      count: testOutcome.enqueued ?? 0,
                    }),
                  })}
                  {/* Said out loud, and only when it happened: a Test that returns
                  two tiles out of forty tracks otherwise reads as a quiet
                  window when it was in fact a car park. */}
                  {(testOutcome.droppedStationary ?? 0) > 0 && (
                    <span data-testid="summary-test-dropped-stationary" className="ml-1">
                      {t('system.notificationProducerRules.droppedStationary', {
                        count: testOutcome.droppedStationary,
                      })}
                    </span>
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
                {t('system.notificationSummaries.dismiss', 'Dismiss')}
              </Button>
            </div>
          )}

          {rules.length === 0 ? (
            <NcListEmpty testId="summary-empty">
              {t(
                'system.notificationSummaries.noSummaryRulesYetCreate',
                'No summary rules yet — create one, and every window it covers arrives as a single picture.',
              )}
            </NcListEmpty>
          ) : (
            <NcListTable<SummaryRuleView>
              columns={summaryColumns({
                nowMs: Date.now(),
                targetNameById,
                deletePending: deleteRule.isPending,
                onToggle: (rule, enabled) => setEnabled.mutate({ ruleId: rule.id, enabled }),
                onOpen: openEditor,
                onTest: setTestRule,
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
        <NotificationSummaryEditor
          rule={editor.rule}
          cameras={cameras}
          fleet={fleetViewOf(fleetQuery)}
          targets={targetOptions}
          taxonomy={catalogQuery.data?.taxonomy}
          onCancel={() => setEditor({ mode: 'closed' })}
          onSaved={() => {
            setEditor({ mode: 'closed' })
            void rulesQuery.refetch()
          }}
        />
      )}

      <DigestTestConfirm
        open={testRule !== null}
        ruleName={testRule?.name ?? ''}
        windowDescription="the last 3 hours"
        targetDescription={`${testRule?.targets.length ?? 0} target${
          (testRule?.targets.length ?? 0) === 1 ? '' : 's'
        }`}
        pending={runTest.isPending}
        onCancel={() => setTestRule(null)}
        onConfirm={() => {
          if (testRule !== null) runTest.mutate(testRule.id)
        }}
      />
    </>
  )

  return (
    <AdminPage
      icon={Images}
      title={t('system.notificationSummaries.summaries', 'Summaries')}
      subtitle={SUBTITLE}
      actions={
        !unavailable ? (
          <Button
            size="sm"
            type="button"
            onClick={() => setEditor({ mode: 'form', rule: null })}
            data-testid="summary-new"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('system.notificationSummaries.newSummary', 'New summary')}
          </Button>
        ) : undefined
      }
    >
      {body}
    </AdminPage>
  )
}

export interface SummaryColumnsDeps {
  readonly nowMs: number
  readonly targetNameById: ReadonlyMap<string, string>
  readonly deletePending: boolean
  readonly onToggle: (rule: SummaryRuleView, enabled: boolean) => void
  readonly onOpen: (rule: SummaryRuleView) => void
  readonly onTest: (rule: SummaryRuleView) => void
  readonly onConfirmDelete: (rule: SummaryRuleView) => void
}

export function summaryColumns(deps: SummaryColumnsDeps): readonly DataColumn<SummaryRuleView>[] {
  return [
    {
      key: 'name',
      header: i18n.t('system.notificationSummaries.digest', 'Digest'),
      render: (rule) => (
        <NcListNameCell
          name={rule.name}
          enabled={rule.enabled}
          {...(isEditableSummaryRule(rule) ? { onOpen: () => deps.onOpen(rule) } : {})}
          openTestId={`summary-edit-${rule.id}`}
          badges={
            <>
              {/* A rule this build cannot author is SAID so in the list, not only
              in the dialog: the operator has to know before clicking. */}
              {!isEditableSummaryRule(rule) && <Badge variant="warning">read-only</Badge>}
              {/* ON vs merely CONFIGURED — the badge answers "will tonight's
              digest carry a written summary", which is the question. */}
              {rule.ai?.enabled === true && <Badge variant="info">AI</Badge>}
              {rule.ai !== undefined && !rule.ai.enabled && (
                <Badge variant="default">
                  {i18n.t('system.notificationSummaries.aiOff', 'AI off')}
                </Badge>
              )}
            </>
          }
        />
      ),
    },
    {
      key: 'cameras',
      header: i18n.t('system.notificationSummaries.cameras', 'Cameras'),
      align: 'center',
      nowrap: true,
      render: (rule) => (
        <span className="text-[11px] text-foreground-subtle">{rule.deviceIds.length}</span>
      ),
    },
    {
      key: 'window',
      header: i18n.t('system.notificationSummaries.window', 'Window'),
      render: (rule) => (
        <span className="text-[11px] text-foreground-subtle">
          {summaryWindowLabel(rule.window)}
        </span>
      ),
    },
    {
      key: 'filters',
      header: i18n.t('system.notificationSummaries.keeps', 'Keeps'),
      render: (rule) => (
        <span className="text-[11px] text-foreground-subtle">
          {summaryFilterLabel(rule.filters)}
        </span>
      ),
    },
    {
      key: 'mosaic',
      header: i18n.t('system.notificationSummaries.mosaic', 'Mosaic'),
      nowrap: true,
      render: (rule) => (
        <span className="text-[11px] text-foreground-subtle">
          {i18n.t('system.notificationSummaries.tilesRank', {
            count: rule.maxTiles,
            rank: rule.rank,
          })}
        </span>
      ),
    },
    {
      key: 'targets',
      header: i18n.t('system.notificationSummaries.targets', 'Targets'),
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
      header: i18n.t('system.notificationSummaries.lastRun', 'Last run'),
      nowrap: true,
      render: (rule) => (
        <span
          className="text-[11px] text-foreground-subtle"
          data-testid={`summary-last-${rule.id}`}
        >
          {summaryLastGeneratedLabel(rule.generatedAt, deps.nowMs)}
        </span>
      ),
    },
    {
      key: 'enabled',
      header: i18n.t('system.notificationSummaries.on', 'On'),
      align: 'center',
      nowrap: true,
      render: (rule) => (
        <NcListRowControls>
          <Switch
            checked={rule.enabled}
            disabled={rule.readOnly}
            onCheckedChange={(next) => deps.onToggle(rule, next)}
            aria-label={i18n.t('system.notificationSummaries.toggle', 'toggle {{name}}', {
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
            disabled={rule.readOnly}
            onClick={() => deps.onTest(rule)}
            title={i18n.t(
              'system.notificationSummaries.produceThisDigestNowAnd',
              'Produce this digest now and DELIVER it',
            )}
            aria-label={i18n.t('system.notificationSummaries.test', 'test {{name}}', {
              name: rule.name,
            })}
            data-testid={`summary-test-${rule.id}`}
          >
            <FlaskConical className="h-3.5 w-3.5" />
          </Button>
          {/* No Edit button: the row IS the edit target (same as Rules). */}
          <NcListDeleteButton
            disabled={rule.readOnly}
            pending={deps.deletePending}
            title={i18n.t('system.notificationSummaries.deleteThisSummary', 'Delete this summary?')}
            message={i18n.t(
              'system.notificationSummaries.thisWillPermanentlyDeleteThis',
              'This will permanently delete "{{name}}". This action cannot be undone.',
              { name: rule.name },
            )}
            ariaLabel={i18n.t('system.notificationSummaries.delete', 'delete {{name}}', {
              name: rule.name,
            })}
            testId={`summary-delete-${rule.id}`}
            onConfirm={() => deps.onConfirmDelete(rule)}
          />
        </NcListRowControls>
      ),
    },
  ]
}

export default NotificationSummariesPage
