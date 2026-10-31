/**
 * The scheduled TIMELAPSE editor — create and edit, one dialog.
 *
 * Like the digest, the producer shipped complete and API-only: the two rules
 * running on this hub tonight were authored with `curl`. This is the surface
 * that authors them.
 *
 * Chrome matches Summaries / Rules: title band (dismiss via Dialog Close),
 * problems/warnings
 * outside the tabs, TabsList above DialogBody, Save row pinned below. Tabs
 * replace the one long scroll of DigestSections so the three create/edit
 * modals scan the same way.
 *
 * What this form is careful about:
 *
 *  1. **The dense cadence is a THREE-state control.** Absent means "derive it"
 *     (`max(1s, base/30)`), resolved at render time from whatever the base
 *     cadence is then. Both live rules are absent. An ordinary number box
 *     pre-filled with the derived value would pin it on the first save and
 *     silently stop tracking the base cadence — so "Automatic" is a real
 *     choice, and the derived number is shown beside it rather than inside it.
 *  2. **The dense knob is explained by its arithmetic**, because it is the one
 *     the operator tunes and the one nobody can predict: a passage of N seconds
 *     sampled every D seconds and played at F fps lasts `(N/D)/F` seconds on
 *     screen. Lower dense cadence = slower near the detections.
 *  3. **A rule with no schedule cannot be saved.** A timelapse is DEFINED by
 *     its window: open clears the scratch, close assembles and delivers.
 *  4. **The caption has three states too** — never set (the shipped
 *     `Timelapse {{camera}}`), empty (deliberately no caption), or a string.
 */

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  Input,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useSystem,
} from '@camstack/ui-library'
import { useMutation } from '@tanstack/react-query'
import { Film, Loader2 } from 'lucide-react'
import { useState } from 'react'

import { TemplateField } from '../../components/notifications/TemplateField'
import { varsForContext } from '../../components/notifications/template-field.helpers'
import { useTemplateCatalog } from '../../components/notifications/use-template-catalog'
import {
  DIGEST_HINT_CLASS,
  DIGEST_LABEL_CLASS,
  DigestCameraField,
  type DigestCameraOption,
  DigestNumberField,
  DigestProblems,
  DigestSection,
  DigestSwitchField,
  type DigestTargetOption,
  DigestTargetsField,
  DigestTemplateFields,
  DigestWarnings,
} from './notification-digest-fields'
import type { DeviceFleetView } from './device-fleet-view'
import { NotificationPruneBanner } from './NotificationPruneBanner'
import { ScheduleField } from './notification-schedule-field'
import {
  buildTimelapseCreateInput,
  buildTimelapsePatch,
  DEFAULT_TIMELAPSE_PREVIEW_TEXT,
  DEFAULT_TIMELAPSE_TAB,
  denseCadenceView,
  denseRangeOutputSeconds,
  emptyTimelapseForm,
  isTimelapseFormValid,
  NC_ADDON_ID,
  NC_TIMELAPSE_TABS,
  NC_UPSERT_TIMELAPSE_RULE_ACTION,
  parseTimelapseTab,
  TIMELAPSE_CADENCE_MAX_SEC,
  TIMELAPSE_CADENCE_MIN_SEC,
  TIMELAPSE_DENSE_FLOOR_SEC,
  TIMELAPSE_FRAMERATE_MAX,
  TIMELAPSE_FRAMERATE_MIN,
  TIMELAPSE_MIN_DWELL_MAX_SEC,
  TIMELAPSE_PREVIEW_MODE_LABELS,
  TIMELAPSE_PREVIEW_MODES,
  type TimelapseFormState,
  type TimelapsePreviewModeChoice,
  type TimelapseRuleView,
  type TimelapseTabKey,
  timelapseFormProblems,
  timelapseFormWarnings,
  timelapseRuleToForm,
} from './notification-timelapse.helpers'
import { Trans, useTranslation } from 'react-i18next'

/** The passage length the dense-cadence hint is written against. */
const EXAMPLE_PASS_SEC = 7

export interface NotificationTimelapseEditorProps {
  readonly rule: TimelapseRuleView | null
  readonly cameras: readonly DigestCameraOption[]
  /** The whole fleet behind `cameras`, and whether it ANSWERED (D315). */
  readonly fleet: DeviceFleetView
  readonly targets: readonly DigestTargetOption[]
  readonly onSaved: () => void
  readonly onCancel: () => void
}

function parsePreviewMode(value: string): TimelapsePreviewModeChoice | undefined {
  return TIMELAPSE_PREVIEW_MODES.find((mode) => mode === value)
}

export function NotificationTimelapseEditor({
  rule,
  cameras,
  fleet,
  targets,
  onSaved,
  onCancel,
}: NotificationTimelapseEditorProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const [form, setForm] = useState<TimelapseFormState>(() =>
    rule === null ? emptyTimelapseForm() : timelapseRuleToForm(rule),
  )
  const [error, setError] = useState<string | null>(null)
  /** Blocking reasons stay hidden on a new rule until the first Create click. */
  const [problemsRevealed, setProblemsRevealed] = useState(rule !== null)
  const [tab, setTab] = useState<TimelapseTabKey>(DEFAULT_TIMELAPSE_TAB)

  const patch = (next: Partial<TimelapseFormState>): void =>
    setForm((prev) => ({ ...prev, ...next }))

  const catalog = useTemplateCatalog()
  const previewTextVars = catalog.data
    ? varsForContext(catalog.data, { family: 'timelapse', field: 'previewText' })
    : undefined

  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      const input =
        rule === null
          ? { rule: buildTimelapseCreateInput(form) }
          : { ruleId: rule.id, patch: buildTimelapsePatch(form, rule) }
      await system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_UPSERT_TIMELAPSE_RULE_ACTION,
        input,
      })
    },
    onSuccess: onSaved,
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Save failed'),
  })

  const problems = timelapseFormProblems(form)
  const warnings = timelapseFormWarnings(form)
  const dense = denseCadenceView(form)
  const passSeconds = denseRangeOutputSeconds(EXAMPLE_PASS_SEC, dense.seconds, form.framerate)
  const activeTab = NC_TIMELAPSE_TABS.some((entry) => entry.key === tab)
    ? tab
    : DEFAULT_TIMELAPSE_TAB

  return (
    <Dialog open onOpenChange={(next) => !next && onCancel()}>
      {/* Same chrome as `NotificationSummaryEditor`: one scroller (`DialogBody`),
          title + problems + TabsList stay put, Save row pinned below. */}
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
        <div className="mb-3 flex shrink-0 items-center gap-2 pr-10">
          <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
            <Film className="h-4 w-4 shrink-0 text-foreground-subtle" />
            <span className="truncate">
              {rule === null
                ? t('system.notificationTimelapseEditor.newTimelapse', 'New timelapse')
                : t('system.notificationTimelapseEditor.edit', 'Edit {{name}}', {
                    name: rule.name,
                  })}
            </span>
          </h3>
        </div>

        {error !== null && (
          <div className="mb-3 shrink-0 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="shrink-0 space-y-2">
          {rule !== null && (
            <NotificationPruneBanner
              kind="timelapse"
              ruleId={rule.id}
              enabled={rule.enabled}
              updatedAt={rule.updatedAt}
            />
          )}
          {problemsRevealed ? (
            <DigestProblems problems={problems} testId="timelapse-problems" />
          ) : null}
          <DigestWarnings warnings={warnings} testId="timelapse-warnings" />
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(next) => setTab(parseTimelapseTab(next) ?? tab)}
          className="mt-3 flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="mb-3 shrink-0">
            {NC_TIMELAPSE_TABS.map((entry) => (
              <TabsTrigger key={entry.key} value={entry.key}>
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <DialogBody className="pr-1">
            <TabsContent value="rule" className="space-y-3">
              <DigestSection
                title={t('system.notificationTimelapseEditor.whatItIs', 'What it is')}
                hint={t(
                  'system.notificationTimelapseEditor.oneVideoPerCameraAssembled',
                  "One video per camera, assembled from that camera's RECORDED footage when the window closes.",
                )}
              >
                <div className="flex items-end gap-3">
                  <div className="min-w-0 flex-1">
                    <label className={DIGEST_LABEL_CLASS}>
                      {t('system.notificationTimelapseEditor.name', 'Name')}
                    </label>
                    <Input
                      value={form.name}
                      onChange={(e) => patch({ name: e.target.value })}
                      placeholder={t(
                        'system.notificationTimelapseEditor.eGNightDriveway',
                        'e.g. Night driveway',
                      )}
                      data-testid="timelapse-name"
                    />
                  </div>
                  <div className="pb-1.5">
                    <DigestSwitchField
                      label={t('system.notificationTimelapseEditor.enabled', 'Enabled')}
                      checked={form.enabled}
                      onChange={(next) => patch({ enabled: next })}
                      testId="timelapse-enabled"
                    />
                  </div>
                </div>
              </DigestSection>

              <DigestSection title={t('system.notificationTimelapseEditor.cameras', 'Cameras')}>
                <DigestCameraField
                  cameras={cameras}
                  value={form.deviceIds}
                  fleet={fleet}
                  onChange={(next) => patch({ deviceIds: next })}
                  hint={t(
                    'system.notificationTimelapseEditor.eachCameraRendersAndDelivers',
                    'Each camera renders and delivers its own video. Recording must be ON for a camera — a timelapse is cut from recorded footage, and the hub refuses a rule for a camera that does not record.',
                  )}
                />
              </DigestSection>
            </TabsContent>

            <TabsContent value="window" className="space-y-3">
              <DigestSection title={t('system.notificationTimelapseEditor.when', 'When')}>
                <div>
                  <label className={DIGEST_LABEL_CLASS}>
                    {t('system.notificationTimelapseEditor.weeklyWindows', 'Weekly windows')}
                  </label>
                  <ScheduleField
                    value={form.schedule}
                    onChange={(next) => patch({ schedule: next })}
                  />
                  <p className={DIGEST_HINT_CLASS}>
                    {t(
                      'system.notificationTimelapseEditor.theVideoCoversExactlyOne',
                      'The video covers exactly one window and is delivered when it CLOSES. A window that crosses midnight (21:00 → 07:00) is the ordinary case for a night timelapse.',
                    )}
                  </p>
                </div>
              </DigestSection>
            </TabsContent>

            <TabsContent value="sampling" className="space-y-3">
              <DigestSection
                title={t('system.notificationTimelapseEditor.sampling', 'Sampling')}
                hint={t(
                  'system.notificationTimelapseEditor.twoRatesABaseRate',
                  'Two rates: a base rate for the whole window, and a denser one inside the ranges where something was detected.',
                )}
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <DigestNumberField
                    label={t(
                      'system.notificationTimelapseEditor.baseCadenceSeconds',
                      'Base cadence (seconds)',
                    )}
                    value={form.cadenceSec}
                    min={TIMELAPSE_CADENCE_MIN_SEC}
                    max={TIMELAPSE_CADENCE_MAX_SEC}
                    onChange={(next) => patch({ cadenceSec: next ?? 0 })}
                    hint={t(
                      'system.notificationTimelapseEditor.oneFrameEveryNSeconds',
                      'One frame every N seconds across the quiet parts of the window.',
                    )}
                    testId="timelapse-cadence"
                  />
                  <DigestNumberField
                    label={t(
                      'system.notificationTimelapseEditor.outputFrameRateFps',
                      'Output frame rate (fps)',
                    )}
                    value={form.framerate}
                    min={TIMELAPSE_FRAMERATE_MIN}
                    max={TIMELAPSE_FRAMERATE_MAX}
                    onChange={(next) => patch({ framerate: next ?? 0 })}
                    hint={t(
                      'system.notificationTimelapseEditor.howFastTheAssembledVideo',
                      'How fast the assembled video plays.',
                    )}
                    testId="timelapse-framerate"
                  />
                </div>

                <div>
                  <label className={DIGEST_LABEL_CLASS}>
                    {t(
                      'system.notificationTimelapseEditor.denseCadenceNearTheDetections',
                      'Dense cadence, near the detections',
                    )}
                  </label>
                  <div className="flex items-center gap-2">
                    <Select
                      value={form.denseCadenceSec === undefined ? 'auto' : 'explicit'}
                      options={[
                        {
                          value: 'auto',
                          label: t(
                            'system.notificationTimelapseEditor.automaticS',
                            'Automatic ({{seconds}}s)',
                            { seconds: dense.seconds },
                          ),
                        },
                        {
                          value: 'explicit',
                          label: t(
                            'system.notificationTimelapseEditor.setItMyself',
                            'Set it myself',
                          ),
                        },
                      ]}
                      onChange={(e) =>
                        patch({
                          denseCadenceSec:
                            e.target.value === 'auto' ? undefined : denseCadenceView(form).seconds,
                        })
                      }
                      data-testid="timelapse-dense-mode"
                    />
                    {form.denseCadenceSec !== undefined && (
                      <Input
                        type="number"
                        className="w-28"
                        min={TIMELAPSE_DENSE_FLOOR_SEC}
                        step={0.1}
                        value={String(form.denseCadenceSec)}
                        onChange={(e) => {
                          const parsed = Number(e.target.value)
                          if (Number.isFinite(parsed)) patch({ denseCadenceSec: parsed })
                        }}
                        data-testid="timelapse-dense-seconds"
                      />
                    )}
                  </div>
                  <p className={DIGEST_HINT_CLASS} data-testid="timelapse-dense-hint">
                    {t('system.notificationTimelapseEditor.denseHint', {
                      seconds: dense.seconds,
                      fps: form.framerate,
                      passage: EXAMPLE_PASS_SEC,
                      onScreen: passSeconds.toFixed(2),
                    })}{' '}
                    {dense.derived
                      ? t('system.notificationTimelapseEditor.denseDerived')
                      : t('system.notificationTimelapseEditor.denseFixed', {
                          seconds: denseCadenceView({ ...form, denseCadenceSec: undefined })
                            .seconds,
                        })}
                  </p>
                </div>

                <DigestNumberField
                  label={t(
                    'system.notificationTimelapseEditor.minimumSecondsOfVideoPer',
                    'Minimum seconds of video per detection (optional)',
                  )}
                  value={form.minDwellSec}
                  min={0}
                  max={TIMELAPSE_MIN_DWELL_MAX_SEC}
                  step={0.5}
                  emptyPlaceholder="no guarantee"
                  onChange={(next) => patch({ minDwellSec: next })}
                  hint={t(
                    'system.notificationTimelapseEditor.stateTheStayAndLet',
                    "State the stay and let the renderer solve for the cadence. It only ever samples DENSER, down to the recording's own frame interval — a passage too short to reach it is rendered with every frame that exists and no more.",
                  )}
                  testId="timelapse-min-dwell"
                />
              </DigestSection>
            </TabsContent>

            <TabsContent value="delivery" className="space-y-3">
              <DigestSection
                title={t('system.notificationTimelapseEditor.theNotification', 'The notification')}
              >
                <DigestTargetsField
                  targets={targets}
                  value={form.targetIds}
                  onChange={(next) => patch({ targetIds: next })}
                />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className={DIGEST_LABEL_CLASS}>
                      {t('system.notificationTimelapseEditor.preview', 'Preview')}
                    </label>
                    <Select
                      value={form.previewMode}
                      options={TIMELAPSE_PREVIEW_MODES.map((mode) => ({
                        value: mode,
                        label: TIMELAPSE_PREVIEW_MODE_LABELS[mode],
                      }))}
                      onChange={(e) => {
                        const next = parsePreviewMode(e.target.value)
                        if (next !== undefined) patch({ previewMode: next })
                      }}
                      data-testid="timelapse-preview-mode"
                    />
                  </div>
                  <DigestNumberField
                    label={t('system.notificationTimelapseEditor.priority', 'Priority')}
                    value={form.priority}
                    min={1}
                    max={5}
                    onChange={(next) => patch({ priority: next ?? 3 })}
                    testId="timelapse-priority"
                  />
                </div>

                <div>
                  <TemplateField
                    label={t(
                      'system.notificationTimelapseEditor.captionOnThePreviewFrame',
                      'Caption on the preview frame',
                    )}
                    value={form.previewTextSet ? form.previewText : ''}
                    placeholder={t(
                      'system.notificationTimelapseEditor.shippedDefault',
                      '{{DEFAULT_TIMELAPSE_PREVIEW_TEXT}} (shipped default)',
                      { DEFAULT_TIMELAPSE_PREVIEW_TEXT },
                    )}
                    onChange={(next) => patch({ previewText: next, previewTextSet: true })}
                    vars={previewTextVars}
                    testId="timelapse-preview-text"
                  />
                  <p className={DIGEST_HINT_CLASS}>
                    {form.previewTextSet && form.previewText.length === 0
                      ? t(
                          'system.notificationTimelapseEditor.emptyAndSetThePreview',
                          'Empty and set: the preview frame carries NO caption.',
                        )
                      : t(
                          'system.notificationTimelapseEditor.leaveUntouchedForTheShipped',
                          'Leave untouched for the shipped caption ({{DEFAULT_TIMELAPSE_PREVIEW_TEXT}}).',
                          { DEFAULT_TIMELAPSE_PREVIEW_TEXT },
                        )}
                    {form.previewTextSet && (
                      <>
                        {' '}
                        <Button
                          variant="unstyled"
                          type="button"
                          className="underline"
                          onClick={() => patch({ previewText: '', previewTextSet: false })}
                          data-testid="timelapse-preview-text-reset"
                        >
                          {t(
                            'system.notificationTimelapseEditor.backToTheShippedCaption',
                            'Back to the shipped caption',
                          )}
                        </Button>
                      </>
                    )}
                  </p>
                </div>

                <DigestTemplateFields
                  title={form.templateTitle}
                  body={form.templateBody}
                  onTitleChange={(next) => patch({ templateTitle: next })}
                  onBodyChange={(next) => patch({ templateBody: next })}
                  family="timelapse"
                  testIdPrefix="timelapse-template"
                />
                <p className="text-[10px] text-foreground-subtle">
                  <Trans
                    i18nKey="system.notificationTimelapseEditor.detectionSummaryNote"
                    values={{ token: '{{detectionSummary}}' }}
                    components={{ code: <code /> }}
                  />
                </p>
              </DigestSection>
            </TabsContent>
          </DialogBody>
        </Tabs>

        <div className="mt-3 flex shrink-0 justify-end gap-2">
          <Button size="sm" variant="secondary" type="button" onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            type="button"
            disabled={save.isPending}
            onClick={() => {
              setProblemsRevealed(true)
              if (!isTimelapseFormValid(form) || save.isPending) return
              save.mutate()
            }}
          >
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {rule === null
              ? t('system.notificationTimelapseEditor.create', 'Create')
              : t('common.save', 'Save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
