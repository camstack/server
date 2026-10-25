/**
 * Notification SIMULATOR — `/system/notifications?tab=simulate`.
 *
 * Injects a synthetic event through the same intake seam the tracker and the
 * sensor ingest use (`nc.injectTestEvent` on `pipeline-analytics`) and reports
 * what every rule did with it: matched or not, the FIRST failing condition, the
 * cooldown verdict, how many outbox rows were enqueued and to which targets.
 *
 * WHY IT EXISTS
 * ─────────────
 * "It did not fire" was previously unanswerable without waiting for the real
 * subject to walk past the camera again. The dry-run on the rule dialog only
 * replays records that already happened, and cannot produce a device event at
 * all. This produces the subject.
 *
 * EVERY VOCABULARY IS FETCHED, NEVER HARDCODED
 * ────────────────────────────────────────────
 *   - classes → the NC taxonomy from `getConditionCatalog` (the SAME query key
 *     the rule editor uses, so both surfaces read one cache entry),
 *   - zones → the camera's real admin zones (`useZoneOptions`, the rule
 *     editor's own picker),
 *   - event kinds → `listEventKindsBatch` for the SELECTED camera, split by
 *     `category`, with `source.deviceId` prefilling the linked source device.
 *
 * A hardcoded list here would offer an operator a value no camera has, and the
 * simulation would answer honestly about an event production can never emit.
 */

import type { EventKindDescriptor, NcRule, Target } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import {
  Button,
  Card,
  ErrorBox,
  Input,
  Select,
  useDeviceManagerListAll,
  useSystem,
} from '@camstack/ui-library'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, FlaskConical, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { AdminPage } from '../../components/AdminPage'
import {
  CATALOG_QUERY_KEY,
  type NcConditionCatalogResult,
  RULES_QUERY_KEY,
  TARGETS_QUERY_KEY,
} from './NotificationRules'
import { AdvancedSection, RunSwitch, WhatHappenedSection } from './NotificationSimulateFields'
import { NotificationSimulateResultPanel } from './NotificationSimulateResult'
import type { RuleCameraOption } from './notification-condition-fields'
import { HINT_CLASS, LABEL_CLASS, NumberField } from './notification-condition-widgets'
import {
  buildSimulateInput,
  clearSimulatePrefill,
  defaultSourceForTrigger,
  deliveryForTrigger,
  emptySimulateForm,
  isSimulateFormValid,
  NC_SIMULATE_TRIGGERS,
  type NcSimulateCaveat,
  type NcSimulateFormState,
  type NcSimulateResult,
  parseOptionalNumberInput,
  parseSimulateResult,
  parseSimulateTrigger,
  peekSimulatePrefill,
  prefillFromRule,
  simulateCaveats,
} from './notification-simulate.helpers'
import { Trans, useTranslation } from 'react-i18next'

/** The addon hosting the notification centre — where the tester lives. */
const NC_ADDON_ID = 'pipeline-analytics'
const NC_TEST_ACTION = 'nc.injectTestEvent'

export function NotificationSimulatePage() {
  const { t } = useTranslation()
  const system = useSystem()
  // Peek, never consume, in the initializer: StrictMode re-invokes it, and a
  // consuming read would hand the prefill to a render React then throws away.
  // The three reads are idempotent by construction; the box is cleared once,
  // after mount, so a later tab switch opens a blank simulator rather than
  // silently re-seeding from a rule the operator has moved on from.
  const [form, setForm] = useState<NcSimulateFormState>(
    () => peekSimulatePrefill()?.form ?? emptySimulateForm(),
  )
  const [caveats, setCaveats] = useState<readonly NcSimulateCaveat[]>(
    () => peekSimulatePrefill()?.caveats ?? [],
  )
  const [seededFrom, setSeededFrom] = useState<string | null>(
    () => peekSimulatePrefill()?.ruleName ?? null,
  )
  useEffect(() => clearSimulatePrefill(), [])

  const [result, setResult] = useState<NcSimulateResult | null>(null)
  const [unreadable, setUnreadable] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const patch = (next: Partial<NcSimulateFormState>): void =>
    setForm((prev) => ({ ...prev, ...next }))

  /**
   * The SAME hook, input and tRPC key the rules page uses — not a hand-shared
   * constant. The two pages previously agreed by importing one
   * `CAMERAS_QUERY_KEY` and writing the fetch body twice, which is a result
   * that depends on which tab was opened first; the comment here said exactly
   * that. Sharing the generated hook makes it structural, and brings the D274
   * window and the `[['deviceManager']]` invalidations with it.
   *
   * `slim` is safe BY FIELD: this reads `type`, `id`, `name`. The camera
   * predicate stays `type === Camera` client-side rather than becoming the
   * server's `isCamera` filter — they are different questions.
   */
  const camerasQuery = useDeviceManagerListAll({ projection: 'slim' })

  const catalogQuery = useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: (): Promise<NcConditionCatalogResult> =>
      system.trpcClient.notificationRules.getConditionCatalog.query({}),
  })

  const rulesQuery = useQuery({
    queryKey: RULES_QUERY_KEY,
    queryFn: async (): Promise<readonly NcRule[]> => {
      const res = await system.trpcClient.notificationRules.listRules.query({})
      return res.rules
    },
  })

  const targetsQuery = useQuery({
    queryKey: TARGETS_QUERY_KEY,
    queryFn: (): Promise<readonly Target[]> =>
      system.trpcClient.notificationOutput.listTargets.query({}),
  })

  const deviceId = form.deviceId
  const kindsQuery = useQuery({
    queryKey: [['pipelineAnalytics', 'listEventKindsBatch'], { deviceId }],
    enabled: deviceId !== null,
    staleTime: 60_000,
    queryFn: async (): Promise<readonly EventKindDescriptor[]> => {
      if (deviceId === null) return []
      const rows = await system.trpcClient.pipelineAnalytics.listEventKindsBatch.query({
        deviceIds: [deviceId],
      })
      return rows.flatMap((row) => [...row.kinds])
    },
  })

  const cameras = useMemo(
    (): readonly RuleCameraOption[] =>
      (camerasQuery.data ?? [])
        .filter((d) => d.type === DeviceType.Camera)
        .map((d) => ({ id: d.id, name: d.name })),
    [camerasQuery.data],
  )
  const taxonomy = catalogQuery.data?.taxonomy
  const kinds = kindsQuery.data ?? []
  const targetNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of targetsQuery.data ?? []) map.set(t.id, t.name)
    return map
  }, [targetsQuery.data])

  const run = useMutation({
    mutationFn: async (): Promise<unknown> => {
      const input = buildSimulateInput(form)
      if (input === null) throw new Error('Pick a camera first.')
      return system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_TEST_ACTION,
        input,
      })
    },
    onMutate: () => {
      setResult(null)
      setUnreadable(false)
      setError(null)
    },
    onSuccess: (raw) => {
      const parsed = parseSimulateResult(raw)
      setResult(parsed)
      setUnreadable(parsed === null)
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'The simulation failed.'),
  })

  const delivery = deliveryForTrigger(form.trigger)
  const onlyRule = rulesQuery.data?.find((r) => r.id === form.onlyRuleId)

  return (
    <AdminPage
      embedded
      icon={FlaskConical}
      title={t('system.notificationSimulate.simulateAnEvent', 'Simulate an event')}
      subtitle={t(
        'system.notificationSimulate.injectASyntheticDetectionDoorbell',
        'Inject a synthetic detection, doorbell press or occupancy edge and see exactly which rules match it, which condition each one fails on, and what would be delivered. Nothing is persisted — no track, no event row, no media.',
      )}
    >
      {camerasQuery.isError && (
        <ErrorBox
          title={t('system.notificationSimulate.failedToLoadCameras', 'Failed to load cameras')}
          message={
            camerasQuery.error instanceof Error
              ? camerasQuery.error.message
              : t('system.notificationSimulate.unknownError', 'Unknown error')
          }
          onRetry={() => void camerasQuery.refetch()}
        />
      )}

      {seededFrom !== null && (
        <div className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-[11px] text-foreground">
          <Trans
            i18nKey="system.notificationSimulate.seededFrom"
            values={{ rule: seededFrom }}
            components={{ b: <span className="font-medium" /> }}
          />
        </div>
      )}

      {caveats.length > 0 && (
        <div className="space-y-1 rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
          {caveats.map((caveat) => (
            <p key={caveat.conditionId} className="flex gap-1.5 text-[11px] text-foreground">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
              <span>{caveat.note}</span>
            </p>
          ))}
        </div>
      )}

      <Card className="space-y-4">
        {/* ── Seed from a rule ─────────────────────────────────── */}
        <div>
          <label className={LABEL_CLASS}>
            {t('system.notificationSimulate.ruleToSimulate', 'Rule to simulate')}
          </label>
          <Select
            data-testid="simulate-seed-rule"
            value={form.onlyRuleId}
            options={[
              {
                value: '',
                label: t(
                  'system.notificationSimulate.pickARuleToPrefill',
                  '— pick a rule to prefill trigger + conditions —',
                ),
              },
              ...(rulesQuery.data ?? []).map((r) => ({
                value: r.id,
                label: `${r.name} · ${r.delivery}`,
              })),
            ]}
            onChange={(e) => {
              const id = e.target.value
              if (id.length === 0) {
                setForm(emptySimulateForm())
                setCaveats([])
                setSeededFrom(null)
                return
              }
              const rule = rulesQuery.data?.find((r) => r.id === id)
              if (rule === undefined) {
                patch({ onlyRuleId: id })
                return
              }
              setForm(prefillFromRule(rule))
              setCaveats(simulateCaveats(rule))
              setSeededFrom(rule.name)
            }}
          />
          <p className={HINT_CLASS}>
            {t(
              'system.notificationSimulate.picksTheTriggerThatRule',
              'Picks the trigger that rule listens for and fills the fields from its conditions. Edit any value below, then inject.',
            )}
          </p>
        </div>

        {/* ── Camera ───────────────────────────────────────────── */}
        <div>
          <label className={LABEL_CLASS}>{t('system.notificationSimulate.camera', 'Camera')}</label>
          <Select
            data-testid="simulate-camera"
            value={form.deviceId === null ? '' : String(form.deviceId)}
            options={[
              {
                value: '',
                label:
                  cameras.length === 0
                    ? t('system.notificationSimulate.loadingCameras', 'Loading cameras…')
                    : t('system.notificationSimulate.pickACamera', '— pick a camera —'),
              },
              ...cameras.map((c) => ({ value: String(c.id), label: c.name })),
            ]}
            onChange={(e) => {
              const next = parseOptionalNumberInput(e.target.value)
              // Changing the camera invalidates its zones and its event kinds —
              // both are per-device catalogues, so a carried-over id would be a
              // value the new camera does not have and could never match.
              patch({
                deviceId: next ?? null,
                zones: [],
                crossingZoneId: '',
                sensorKind: '',
                sourceDeviceId: null,
                occupancy: { ...form.occupancy, zoneId: '' },
              })
            }}
          />
          <p className={HINT_CLASS}>
            {t(
              'system.notificationSimulate.theCameraTheEventIs',
              'The camera the event is attributed to — what a notification shows.',
            )}
          </p>
        </div>

        {/* ── Trigger ──────────────────────────────────────────── */}
        <div>
          <label className={LABEL_CLASS}>
            {t('system.notificationSimulate.trigger', 'Trigger')}
          </label>
          <Select
            data-testid="simulate-trigger"
            value={form.trigger}
            options={NC_SIMULATE_TRIGGERS.map((t) => ({ value: t.value, label: t.label }))}
            onChange={(e) => {
              const next = parseSimulateTrigger(e.target.value)
              if (!next) return
              // Carry the new trigger's production provenance, but never
              // overwrite a source the operator chose themselves — only one
              // that was there as the OLD trigger's default.
              const previousDefault = defaultSourceForTrigger(form.trigger)
              const source =
                form.source === '' || form.source === previousDefault
                  ? defaultSourceForTrigger(next)
                  : form.source
              patch({ trigger: next, source })
            }}
          />
          <p className={HINT_CLASS}>
            {NC_SIMULATE_TRIGGERS.find((trigger) => trigger.value === form.trigger)?.hint}{' '}
            <Trans
              i18nKey="system.notificationSimulate.onlyRulesWhoseTrigger"
              values={{ delivery }}
              components={{ b: <span className="text-foreground" /> }}
            />
          </p>
        </div>

        {/* ── What happened ────────────────────────────────────── */}
        <WhatHappenedSection
          form={form}
          cameras={cameras}
          taxonomy={taxonomy}
          kinds={kinds}
          kindsLoading={kindsQuery.isLoading}
          onPatch={patch}
        />

        {/* ── Quality ──────────────────────────────────────────── */}
        <details className="rounded-md border border-border px-3 py-2" open>
          <summary className="cursor-pointer text-[11px] font-semibold text-foreground">
            {t('system.notificationSimulate.quality', 'Quality')}
          </summary>
          <div className="mt-2 space-y-3">
            <p className={HINT_CLASS}>
              {t(
                'system.notificationSimulate.everyFieldHereCanBe',
                'Every field here can be left EMPTY, and empty is a real state: a rule with a minimum confidence FAILS on a subject that carries none. Leave one blank to reproduce exactly that.',
              )}
            </p>
            <div>
              <label className={LABEL_CLASS}>
                {t(
                  'system.notificationSimulate.labelIdentityNamePlateSubclass',
                  'Label (identity name / plate / subclass)',
                )}
              </label>
              <Input
                value={form.label}
                placeholder={t('system.notificationSimulate.eGMarcoAb123cd', 'e.g. Marco, AB123CD')}
                onChange={(e) => patch({ label: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={LABEL_CLASS}>
                  {t('system.notificationSimulate.detectionConfidence', 'Detection confidence')}
                </label>
                <NumberField
                  value={form.confidence}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => patch({ confidence: v })}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>
                  {t('system.notificationSimulate.labelMatchConfidence', 'Label-match confidence')}
                </label>
                <NumberField
                  value={form.labelConfidence}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => patch({ labelConfidence: v })}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>
                  {t('system.notificationSimulate.importance', 'Importance')}
                </label>
                <NumberField
                  value={form.importance}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => patch({ importance: v })}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>
                  {t('system.notificationSimulate.dwellSeconds', 'Dwell (seconds)')}
                </label>
                <NumberField
                  value={form.dwellSeconds}
                  min={0}
                  step={1}
                  onChange={(v) => patch({ dwellSeconds: v })}
                />
              </div>
            </div>
          </div>
        </details>

        {/* ── Advanced ─────────────────────────────────────────── */}
        <AdvancedSection form={form} cameras={cameras} onPatch={patch} />

        {/* ── How to run it ────────────────────────────────────── */}
        <div className="space-y-2 rounded-md border border-border px-3 py-2">
          <div className="text-[11px] font-semibold text-foreground">
            {t('system.notificationSimulate.howToRunIt', 'How to run it')}
          </div>
          <RunSwitch
            checked={form.bypassCooldown}
            label={t('system.notificationSimulate.ignoreTheCooldown', 'Ignore the cooldown')}
            hint={t(
              'system.notificationSimulate.aRuleThatAlreadyFired',
              'A rule that already fired recently is normally silenced. Turn this on to fire anyway; leave it off to SEE the suppression.',
            )}
            onChange={(v) => patch({ bypassCooldown: v })}
          />
          <RunSwitch
            checked={form.bypassMute}
            label={t(
              'system.notificationSimulate.ignoreMutesAndSnoozes',
              'Ignore mutes and snoozes',
            )}
            hint={t(
              'system.notificationSimulate.aMutedCameraOrA',
              'A muted camera or a snoozed rule drops the event before any rule is consulted.',
            )}
            onChange={(v) => patch({ bypassMute: v })}
          />
          <RunSwitch
            checked={form.runActions}
            danger
            label={t(
              'system.notificationSimulate.runTheRuleSActions',
              "Run the rule's actions — this actuates real devices",
            )}
            hint={t(
              'system.notificationSimulate.aMatchedRuleSOntrigger',
              "A matched rule's onTrigger sequences run for real: locks unlock, lights switch, sirens sound. Off unless you mean it.",
            )}
            onChange={(v) => patch({ runActions: v })}
          />
          <div className="max-w-[14rem]">
            <label className={LABEL_CLASS}>
              {t('system.notificationSimulate.stillImage', 'Still image')}
            </label>
            <Select
              value={form.still}
              options={[
                {
                  value: 'live',
                  label: t(
                    'system.notificationSimulate.liveSnapshotOfTheCamera',
                    'Live snapshot of the camera',
                  ),
                },
                { value: 'none', label: t('system.notificationSimulate.noImage', 'No image') },
              ]}
              onChange={(e) => patch({ still: e.target.value === 'none' ? 'none' : 'live' })}
            />
          </div>
          <div>
            <label className={LABEL_CLASS}>
              {t('system.notificationSimulate.evaluateOnlyOneRule', 'Evaluate only one rule')}
            </label>
            <Select
              value={form.onlyRuleId}
              options={[
                {
                  value: '',
                  label: t(
                    'system.notificationSimulate.everyEnabledRule',
                    '— every enabled rule —',
                  ),
                },
                ...(rulesQuery.data ?? []).map((r) => ({ value: r.id, label: r.name })),
              ]}
              onChange={(e) => patch({ onlyRuleId: e.target.value })}
            />
            {form.onlyRuleId.length > 0 && onlyRule === undefined && (
              <p className={HINT_CLASS}>
                <Trans
                  i18nKey="system.notificationSimulate.ruleNotInList"
                  values={{ id: form.onlyRuleId }}
                  components={{ code: <code /> }}
                />
              </p>
            )}
          </div>
        </div>

        {error !== null && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        {/* Wraps: the caveat is a sentence and "Inject event" is the button
            that DELIVERS. Squeezing them onto one row at phone width cut the
            sentence, and it is the sentence that says what the button does. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 flex-1 text-[10px] text-foreground-subtle">
            {t(
              'system.notificationSimulate.nothingIsPersistedNoTrack',
              'Nothing is persisted: no track, no event row, no stored media. Delivery is real.',
            )}
          </p>
          <Button
            size="sm"
            type="button"
            disabled={run.isPending || !isSimulateFormValid(form)}
            onClick={() => run.mutate()}
          >
            {run.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FlaskConical className="h-3.5 w-3.5" />
            )}
            {t('system.notificationSimulate.injectEvent', 'Inject event')}
          </Button>
        </div>
      </Card>

      {unreadable && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-foreground">
          {t(
            'system.notificationSimulate.theHubAnsweredButThis',
            'The hub answered, but this build could not read the answer. That is what a hub older than the simulator looks like — update the server, then re-run.',
          )}
        </div>
      )}

      {result !== null && (
        <NotificationSimulateResultPanel
          result={result}
          targetName={(id) => targetNameById.get(id) ?? id}
        />
      )}
    </AdminPage>
  )
}

export default NotificationSimulatePage
