/**
 * The multi-camera DIGEST editor — create and edit, one dialog, six tabs.
 *
 * A summary rule was API-only until this shipped: the engine, the mosaic
 * renderer, the motion window and the track-close barrier were all live and
 * there was nothing an operator could press to author one.
 *
 * Four things about this form are not cosmetic:
 *
 *  1. **It is TABBED, like the detection-rule editor.** Operator report on the
 *     screenshot: *"non ci sono sezioni organizzate"*. It was one long scroll
 *     of titled blocks beside a rules editor that has had tabs since
 *     2026-08-04, so the two surfaces that both answer "when do I get told
 *     about this" looked like two different products. The tab set and the
 *     fields each tab claims live in `NC_SUMMARY_TABS`, and the spec checks
 *     every form field is claimed exactly once — a field no tab renders is a
 *     field the operator silently loses, because the form still round-trips it.
 *  2. **The class filter is MACRO-ONLY.** `filterSummaryCandidates` matches the
 *     track's stored `className` LITERALLY — it does not go through the
 *     engine's macro-expanding `expandClassSelector`. Every track on this hub
 *     carries a macro (`person` / `vehicle` / `animal`, sampled live on
 *     2026-08-13), so offering `car` would author a filter that can never match
 *     anything — the identical trap that shipped two dead occupancy rules on
 *     device 102. The vocabulary is therefore the shared `occupancy` picker's,
 *     not the `classes` one.
 *  3. **Zones are per camera.** The rule's zone list is flat, and the engine
 *     scopes it per device (`scopeZoneIdsToDevice`), so the picker only offers
 *     the zones of the cameras this rule actually names.
 *  4. **A rule that could never produce cannot be saved**, and the reason is on
 *     screen. Discovering it at 07:05 is not an option: the window has closed
 *     and does not come back.
 *
 * The AI tab is REAL as of #35 P2 — it was a read-only note saying "not wired
 * yet". Everything it authors is a field of `NcSummaryAiSchema`, and it authors
 * ALL of them: the patch writes `ai` as one object, so a field with no control
 * here would be a field the next save deletes.
 */

import type { LlmProfile, NcTaxonomy } from '@camstack/types'
import { pickerForCondition } from '@camstack/types'
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
  Textarea,
} from '@camstack/ui-library'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Images, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'

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
import { OptionListField, useZoneOptions } from './notification-rule-pickers'
import { NotificationPruneBanner } from './NotificationPruneBanner'
import { ScheduleField } from './notification-schedule-field'
import {
  buildSummaryCreateInput,
  buildSummaryPatch,
  DEFAULT_SUMMARY_TAB,
  emptySummaryForm,
  isSummaryFormValid,
  NC_ADDON_ID,
  NC_SUMMARY_TABS,
  NC_UPSERT_SUMMARY_RULE_ACTION,
  parseSummaryTab,
  SUMMARY_AI_LANGUAGES,
  SUMMARY_AI_MAX_IMAGE_PX_MAX,
  SUMMARY_AI_MAX_IMAGE_PX_MIN,
  SUMMARY_AI_MAX_PROMPT,
  SUMMARY_AI_ON_FAILURE,
  SUMMARY_AI_TIMEOUT_SECONDS_MAX,
  SUMMARY_AI_TIMEOUT_SECONDS_MIN,
  SUMMARY_BARRIER_SECONDS_MAX,
  SUMMARY_CAPTIONS,
  SUMMARY_CAPTIONS_LABELS,
  SUMMARY_MAX_AI_IMAGES,
  SUMMARY_MAX_DWELL_SECONDS,
  SUMMARY_MAX_TILES,
  SUMMARY_MAX_WINDOW_SECONDS_MAX,
  SUMMARY_MAX_WINDOW_SECONDS_MIN,
  SUMMARY_QUIET_SECONDS_MAX,
  SUMMARY_QUIET_SECONDS_MIN,
  SUMMARY_RANK_LABELS,
  SUMMARY_RANKS,
  type SummaryAiLanguage,
  type SummaryAiOnFailure,
  type SummaryCaptions,
  type SummaryEditableRule,
  type SummaryFormState,
  type SummaryRank,
  type SummaryTabKey,
  summaryFormProblems,
  summaryFormWarnings,
  summaryRuleToForm,
} from './notification-summaries.helpers'
import { Trans, useTranslation } from 'react-i18next'

/** What the two `onFailure` values MEAN, in the operator's terms. */
const AI_ON_FAILURE_LABELS: Readonly<Record<SummaryAiOnFailure, string>> = {
  'deliver-without-text': 'Deliver the digest anyway, without the text',
  skip: 'Hold the whole digest — deliver nothing',
}

const AI_LANGUAGE_LABELS: Readonly<Record<SummaryAiLanguage, string>> = {
  en: 'English',
  it: 'Italiano',
}

export interface NotificationSummaryEditorProps {
  /** The rule being edited, or `null` for a new one. */
  readonly rule: SummaryEditableRule | null
  readonly cameras: readonly DigestCameraOption[]
  /** The whole fleet behind `cameras`, and whether it ANSWERED (D315). */
  readonly fleet: DeviceFleetView
  readonly targets: readonly DigestTargetOption[]
  /** Picker vocabulary; absent on a hub that predates it → no class picker. */
  readonly taxonomy: NcTaxonomy | undefined
  readonly onSaved: () => void
  readonly onCancel: () => void
}

function parseRank(value: string): SummaryRank | undefined {
  return SUMMARY_RANKS.find((rank) => rank === value)
}

function parseCaptions(value: string): SummaryCaptions | undefined {
  return SUMMARY_CAPTIONS.find((mode) => mode === value)
}

function parseAiLanguage(value: string): SummaryAiLanguage | '' {
  return SUMMARY_AI_LANGUAGES.find((l) => l === value) ?? ''
}

function parseAiOnFailure(value: string): SummaryAiOnFailure | undefined {
  return SUMMARY_AI_ON_FAILURE.find((v) => v === value)
}

export function NotificationSummaryEditor({
  rule,
  cameras,
  fleet,
  targets,
  taxonomy,
  onSaved,
  onCancel,
}: NotificationSummaryEditorProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const [form, setForm] = useState<SummaryFormState>(() =>
    rule === null ? emptySummaryForm() : summaryRuleToForm(rule),
  )
  const [error, setError] = useState<string | null>(null)
  /** Blocking reasons stay hidden on a new rule until the first Create click. */
  const [problemsRevealed, setProblemsRevealed] = useState(rule !== null)
  const [tab, setTab] = useState<SummaryTabKey>(DEFAULT_SUMMARY_TAB)

  const patch = (next: Partial<SummaryFormState>): void => setForm((prev) => ({ ...prev, ...next }))

  /**
   * MACRO CLASSES ONLY — the `occupancy` picker, not the `classes` one. See
   * the module docblock: the digest matches a track's stored class literally,
   * and every stored class is a macro.
   */
  const classOptions = useMemo(() => {
    const picker = pickerForCondition('occupancy', taxonomy)
    return picker === null ? [] : picker.groups.flatMap((g) => g.options)
  }, [taxonomy])

  const { options: zoneOptions, loading: zonesLoading } = useZoneOptions(
    form.deviceIds,
    cameras.map((c) => ({ id: c.id, name: c.name })),
  )

  /**
   * The vision profiles this hub can reach.
   *
   * Read through `system.trpcClient` like every other query on this page, and
   * FAILING SOFT on purpose: a hub with no AI addon deployed answers an error,
   * and that must leave the operator with "the hub's default profile" rather
   * than a dialog that will not open. `enabled` only once the AI tab is
   * reachable, so a rule with no AI never pays for the round-trip.
   */
  const profilesQuery = useQuery({
    queryKey: ['llm', 'listProfiles', 'summary-editor'],
    queryFn: (): Promise<readonly LlmProfile[]> => system.trpcClient.llm.listProfiles.query({}),
    retry: false,
  })
  const visionProfiles = (profilesQuery.data ?? []).filter((p) => p.supportsVision)

  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      const input =
        rule === null
          ? { rule: buildSummaryCreateInput(form) }
          : { ruleId: rule.id, patch: buildSummaryPatch(form, rule) }
      await system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_UPSERT_SUMMARY_RULE_ACTION,
        input,
      })
    },
    onSuccess: onSaved,
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Save failed'),
  })

  const catalog = useTemplateCatalog()
  const captionVars = catalog.data
    ? varsForContext(catalog.data, { family: 'summary', field: 'captionText' })
    : undefined

  /** The title band is the only thing `captionText` can land on. */
  const captionBandDrawn = form.mosaicCaptions === 'all'
  const problems = summaryFormProblems(form)
  const warnings = summaryFormWarnings(form)
  const activeTab = NC_SUMMARY_TABS.some((entry) => entry.key === tab) ? tab : DEFAULT_SUMMARY_TAB

  return (
    <Dialog open onOpenChange={(next) => !next && onCancel()}>
      {/* `scroll="body"` replaces a `max-h-[70vh]` scroller nested inside a
          dialog that was ALSO scrolling: two scrollbars, a title that could
          still be scrolled off, and a cap measured against the raw viewport
          (`vh`) rather than the dialog's own safe-area-aware height. One
          scroller, one cap, chrome that stays. */}
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
        <div className="mb-3 flex shrink-0 items-center gap-2 pr-10">
          <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
            <Images className="h-4 w-4 shrink-0 text-foreground-subtle" />
            <span className="truncate">
              {rule === null
                ? t('system.notificationSummaryEditor.newSummary', 'New summary')
                : t('system.notificationSummaryEditor.edit', 'Edit {{name}}', { name: rule.name })}
            </span>
          </h3>
        </div>

        {error !== null && (
          <div className="mb-3 shrink-0 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        {/* Problems and warnings live OUTSIDE the tabs. Every one of them is a
            reason Save is disabled, and a reason parked on a tab you are not
            looking at is a disabled button with no explanation — which reads
            as a broken page, not a broken rule. */}
        <div className="shrink-0 space-y-2">
          {rule !== null && (
            <NotificationPruneBanner
              kind="summary"
              ruleId={rule.id}
              enabled={rule.enabled}
              updatedAt={rule.updatedAt ?? Number.POSITIVE_INFINITY}
            />
          )}
          {problemsRevealed ? (
            <DigestProblems problems={problems} testId="summary-problems" />
          ) : null}
          <DigestWarnings warnings={warnings} testId="summary-warnings" />
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(next) => setTab(parseSummaryTab(next) ?? tab)}
          className="mt-3 flex min-h-0 flex-1 flex-col"
        >
          {/* Above the scroller, never inside it — same reasoning as the rules
              dialog: switching tab is how you reach five sixths of this form. */}
          <TabsList className="mb-3 shrink-0">
            {NC_SUMMARY_TABS.map((entry) => (
              <TabsTrigger key={entry.key} value={entry.key}>
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <DialogBody className="pr-1">
            <TabsContent value="rule" className="space-y-3">
              <DigestSection
                title={t('system.notificationSummaryEditor.whatItIs', 'What it is')}
                hint={t(
                  'system.notificationSummaryEditor.oneWindowOnePictureThe',
                  'One window, one picture: the best shot of every track the window held, laid out as one mosaic and delivered once.',
                )}
              >
                <div className="flex items-end gap-3">
                  <div className="min-w-0 flex-1">
                    <label className={DIGEST_LABEL_CLASS}>
                      {t('system.notificationSummaryEditor.name', 'Name')}
                    </label>
                    <Input
                      value={form.name}
                      onChange={(e) => patch({ name: e.target.value })}
                      placeholder={t(
                        'system.notificationSummaryEditor.eGOvernightSweep',
                        'e.g. Overnight sweep',
                      )}
                      data-testid="summary-name"
                    />
                  </div>
                  <div className="pb-1.5">
                    <DigestSwitchField
                      label={t('system.notificationSummaryEditor.enabled', 'Enabled')}
                      checked={form.enabled}
                      onChange={(next) => patch({ enabled: next })}
                      testId="summary-enabled"
                    />
                  </div>
                </div>
              </DigestSection>

              <DigestSection
                title={t('system.notificationSummaryEditor.cameras', 'Cameras')}
                hint={t(
                  'system.notificationSummaryEditor.everyCameraInTheDigest',
                  'Every camera in the digest gets at least one tile when it contributed anything — a digest in which two of six cameras never appear is not multi-camera.',
                )}
              >
                <DigestCameraField
                  cameras={cameras}
                  value={form.deviceIds}
                  fleet={fleet}
                  onChange={(next) => patch({ deviceIds: next })}
                  hint={t(
                    'system.notificationSummaryEditor.theFirstCameraSelectedOwns',
                    'The first camera selected owns the delivered notification.',
                  )}
                />
              </DigestSection>
            </TabsContent>

            <TabsContent value="window" className="space-y-3">
              <DigestSection
                title={t(
                  'system.notificationSummaryEditor.whenTheWindowCloses',
                  'When the window closes',
                )}
              >
                <div>
                  <label className={DIGEST_LABEL_CLASS}>
                    {t('system.notificationSummaryEditor.window', 'Window')}
                  </label>
                  <Select
                    value={form.windowKind}
                    options={[
                      {
                        value: 'motion',
                        label: t(
                          'system.notificationSummaryEditor.motionOpenedAndClosedBy',
                          'Motion — opened and closed by activity',
                        ),
                      },
                      {
                        value: 'schedule',
                        label: t(
                          'system.notificationSummaryEditor.scheduleFixedWeeklyWindows',
                          'Schedule — fixed weekly windows',
                        ),
                      },
                    ]}
                    onChange={(e) =>
                      patch({
                        windowKind: e.target.value === 'schedule' ? 'schedule' : 'motion',
                      })
                    }
                    data-testid="summary-window-kind"
                  />
                </div>

                {form.windowKind === 'motion' ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <DigestNumberField
                      label={t(
                        'system.notificationSummaryEditor.quietPeriodSeconds',
                        'Quiet period (seconds)',
                      )}
                      value={form.quietSeconds}
                      min={SUMMARY_QUIET_SECONDS_MIN}
                      max={SUMMARY_QUIET_SECONDS_MAX}
                      onChange={(next) => patch({ quietSeconds: next ?? 0 })}
                      hint={t(
                        'system.notificationSummaryEditor.theWindowOpensOnThe',
                        'The window opens on the first motion on any of these cameras and stays open while more arrives. This much silence closes it.',
                      )}
                      testId="summary-quiet"
                    />
                    <DigestNumberField
                      label={t(
                        'system.notificationSummaryEditor.longestWindowSeconds',
                        'Longest window (seconds)',
                      )}
                      value={form.maxWindowSeconds}
                      min={SUMMARY_MAX_WINDOW_SECONDS_MIN}
                      max={SUMMARY_MAX_WINDOW_SECONDS_MAX}
                      onChange={(next) => patch({ maxWindowSeconds: next ?? 0 })}
                      hint={t(
                        'system.notificationSummaryEditor.aPermanentlyBusyDrivewayWould',
                        'A permanently busy driveway would otherwise never deliver. At this bound the window closes with whatever it holds.',
                      )}
                      testId="summary-max-window"
                    />
                  </div>
                ) : (
                  <div>
                    <label className={DIGEST_LABEL_CLASS}>
                      {t('system.notificationSummaryEditor.weeklyWindows', 'Weekly windows')}
                    </label>
                    <ScheduleField
                      value={form.schedule}
                      onChange={(next) => patch({ schedule: next })}
                    />
                    <p className={DIGEST_HINT_CLASS}>
                      {t(
                        'system.notificationSummaryEditor.theDigestIsProducedWhen',
                        'The digest is produced when a window CLOSES, and covers exactly that window. The first one is the first window that closes after you save — nothing is backfilled.',
                      )}
                    </p>
                  </div>
                )}

                <DigestNumberField
                  label={t(
                    'system.notificationSummaryEditor.waitForOpenTracksSeconds',
                    'Wait for open tracks (seconds)',
                  )}
                  value={form.barrierSeconds}
                  min={0}
                  max={SUMMARY_BARRIER_SECONDS_MAX}
                  onChange={(next) => patch({ barrierSeconds: next ?? 0 })}
                  hint={t(
                    'system.notificationSummaryEditor.aTrackSBestShot',
                    "A track's best shot is written when the track ENDS. Rendering the instant the window closes would show every still-moving subject with no picture. 0 disables the wait.",
                  )}
                  testId="summary-barrier"
                />
              </DigestSection>
            </TabsContent>

            <TabsContent value="content" className="space-y-3">
              <DigestSection
                title={t('system.notificationSummaryEditor.whatGoesIn', 'What goes in')}
                hint={t(
                  'system.notificationSummaryEditor.evaluatedOnTracksOnePassage',
                  'Evaluated on tracks: one passage is one tile.',
                )}
              >
                <div>
                  <label className={DIGEST_LABEL_CLASS}>
                    {t('system.notificationSummaryEditor.classes', 'Classes')}
                  </label>
                  <OptionListField
                    options={classOptions}
                    value={form.classes}
                    onChange={(next) => patch({ classes: next })}
                    emptyHint="No class vocabulary from this hub — leave empty to keep every class."
                    placeholder=""
                    noFreeText
                  />
                  <p className={DIGEST_HINT_CLASS}>
                    {t(
                      'system.notificationSummaryEditor.emptyEveryClassOnlyThe',
                      'Empty = every class. Only the macro classes are offered: a digest matches the class stored on the track, and tracks store macros — a sub-type would match nothing, forever.',
                    )}
                  </p>
                </div>

                <div>
                  <label className={DIGEST_LABEL_CLASS}>
                    {t('system.notificationSummaryEditor.excludedClasses', 'Excluded classes')}
                  </label>
                  <OptionListField
                    options={classOptions}
                    value={form.classesExclude}
                    onChange={(next) => patch({ classesExclude: next })}
                    emptyHint="No class vocabulary from this hub."
                    placeholder=""
                    noFreeText
                  />
                </div>

                <div>
                  <label className={DIGEST_LABEL_CLASS}>
                    {t('system.notificationSummaryEditor.zones', 'Zones')}
                  </label>
                  <OptionListField
                    options={zoneOptions}
                    value={form.zones}
                    onChange={(next) => patch({ zones: next })}
                    loading={zonesLoading}
                    emptyHint="Pick a camera first — the zones offered are its own."
                    placeholder=""
                    noFreeText
                  />
                  <p className={DIGEST_HINT_CLASS}>
                    {t(
                      'system.notificationSummaryEditor.zonesAreScopedPerCamera',
                      'Zones are scoped per camera: picking a zone on one camera does not mute the others, which keep matching on the whole frame.',
                    )}
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <DigestNumberField
                    label={t(
                      'system.notificationSummaryEditor.minimumImportance',
                      'Minimum importance',
                    )}
                    value={form.minImportance}
                    min={0}
                    max={1}
                    step={0.05}
                    emptyPlaceholder="any"
                    onChange={(next) => patch({ minImportance: next })}
                    hint={t(
                      'system.notificationSummaryEditor.thePipelineSOwnScore',
                      "The pipeline's own score, 0–1. Empty keeps everything.",
                    )}
                    testId="summary-min-importance"
                  />
                  <DigestNumberField
                    label={t(
                      'system.notificationSummaryEditor.minimumStaySeconds',
                      'Minimum stay (seconds)',
                    )}
                    value={form.minDwellSeconds}
                    min={0}
                    max={SUMMARY_MAX_DWELL_SECONDS}
                    emptyPlaceholder="any"
                    onChange={(next) => patch({ minDwellSeconds: next })}
                    hint={t(
                      'system.notificationSummaryEditor.dropsThePassagesTooBrief',
                      'Drops the passages too brief to be worth a tile.',
                    )}
                    testId="summary-min-dwell"
                  />
                </div>

                <DigestSwitchField
                  label={t(
                    'system.notificationSummaryEditor.includeParkedObjects',
                    'Include parked objects',
                  )}
                  checked={form.includeStationary}
                  onChange={(next) => patch({ includeStationary: next })}
                  hint={t(
                    'system.notificationSummaryEditor.offByDefaultACar',
                    'Off by default. A car left in the drive is tracked until it is recognised as parked, and it stays parked for as long as it is there — with this on, a digest fills up with the same stationary object instead of the passages. Parked objects remain on the Events page either way.',
                  )}
                  testId="summary-include-stationary"
                />
              </DigestSection>
            </TabsContent>

            <TabsContent value="mosaic" className="space-y-3">
              <DigestSection title={t('system.notificationSummaryEditor.theMosaic', 'The mosaic')}>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <DigestNumberField
                    label={t('system.notificationSummaryEditor.tiles', 'Tiles')}
                    value={form.maxTiles}
                    min={1}
                    max={SUMMARY_MAX_TILES}
                    onChange={(next) => patch({ maxTiles: next ?? 1 })}
                    hint={t(
                      'system.notificationSummaryEditor.9A33Grid',
                      '9 (a 3×3 grid) is the most a phone lock-screen thumbnail can carry and still be read.',
                    )}
                    testId="summary-max-tiles"
                  />
                  <div>
                    <label className={DIGEST_LABEL_CLASS}>
                      {t(
                        'system.notificationSummaryEditor.whenThereAreMoreTracks',
                        'When there are more tracks than tiles',
                      )}
                    </label>
                    <Select
                      value={form.rank}
                      options={SUMMARY_RANKS.map((rank) => ({
                        value: rank,
                        label: SUMMARY_RANK_LABELS[rank],
                      }))}
                      onChange={(e) => {
                        const next = parseRank(e.target.value)
                        if (next !== undefined) patch({ rank: next })
                      }}
                      data-testid="summary-rank"
                    />
                    <p className={DIGEST_HINT_CLASS}>
                      {t(
                        'system.notificationSummaryEditor.everyContributingCameraKeepsIts',
                        'Every contributing camera keeps its single best tile first; the remaining slots go to this ranking.',
                      )}
                    </p>
                  </div>
                </div>
                <div>
                  <label className={DIGEST_LABEL_CLASS}>
                    {t('system.notificationSummaryEditor.textOnTheMosaic', 'Text on the mosaic')}
                  </label>
                  <Select
                    value={form.mosaicCaptions}
                    options={SUMMARY_CAPTIONS.map((mode) => ({
                      value: mode,
                      label: SUMMARY_CAPTIONS_LABELS[mode],
                    }))}
                    onChange={(e) => {
                      const next = parseCaptions(e.target.value)
                      if (next !== undefined) patch({ mosaicCaptions: next })
                    }}
                    data-testid="summary-captions"
                  />
                  <p className={DIGEST_HINT_CLASS}>
                    {t(
                      'system.notificationSummaryEditor.imagesOnlyIsTheDefault',
                      'Images only is the default, and it is what a rule with nothing set here does. Anything drawn is burnt into the picture for good — a label covers the bottom of the tile, which is where feet, wheels and parcels are, and a caption from a detection that was wrong cannot be un-drawn. Nothing downstream needs the words: the written summary reads the frames themselves and is told the camera, the class and the time in its prompt.',
                    )}
                  </p>
                </div>
                <div>
                  <TemplateField
                    label={t(
                      'system.notificationSummaryEditor.captionBurnedOntoTheMosaic',
                      'Caption burned onto the mosaic',
                    )}
                    value={form.captionText}
                    disabled={!captionBandDrawn}
                    onChange={(next) => patch({ captionText: next })}
                    placeholder={t(
                      'system.notificationSummaryEditor.leaveEmptyForNoCaption',
                      'Leave empty for no caption',
                    )}
                    vars={captionVars}
                    testId="summary-caption"
                  />
                  <p className={DIGEST_HINT_CLASS}>
                    {captionBandDrawn
                      ? t(
                          'system.notificationSummaryEditor.acrossTheTopBand',
                          'Across the top band.',
                        )
                      : t(
                          'system.notificationSummaryEditor.onlyDrawnWithTileLabels',
                          'Only drawn with “tile labels and a caption across the top”. What you type here is kept either way.',
                        )}
                  </p>
                </div>
              </DigestSection>
            </TabsContent>

            <TabsContent value="ai" className="space-y-3">
              <DigestSection
                title={t('system.notificationSummaryEditor.writtenSummary', 'Written summary')}
                hint={t(
                  'system.notificationSummaryEditor.oneVisionCallOverThe',
                  "One vision call over the window's best frames TOGETHER, so the answer is an account of what happened rather than a list of pictures. The sentence goes in the notification body.",
                )}
              >
                <DigestSwitchField
                  label={t(
                    'system.notificationSummaryEditor.haveAModelDescribeThe',
                    'Have a model describe the window',
                  )}
                  checked={form.aiEnabled}
                  onChange={(next) => patch({ aiEnabled: next })}
                  hint={t(
                    'system.notificationSummaryEditor.offByDefaultTheMosaic',
                    'Off by default. The mosaic and the counts are delivered either way.',
                  )}
                  testId="summary-ai-enabled"
                />

                {/* Every control below is gated on the switch, and an inert
                    dropdown that nobody warned you about reads as a broken one
                    — that is verbatim the report this note answers. The fields
                    also DIM now (the `Select`/`Input` primitives), but a dimmed
                    field still has to say what would un-dim it. */}
                {!form.aiEnabled && (
                  <p
                    className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[10px] text-foreground-muted"
                    data-testid="summary-ai-off-note"
                  >
                    {t(
                      'system.notificationSummaryEditor.theSwitchAboveIsOff',
                      'The switch above is off, so nothing below it can be edited. Everything you already set is kept — turning it on hands the fields back exactly as you left them.',
                    )}
                  </p>
                )}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className={DIGEST_LABEL_CLASS}>
                      {t('system.notificationSummaryEditor.visionProfile', 'Vision profile')}
                    </label>
                    <Select
                      value={form.aiProfileId}
                      disabled={!form.aiEnabled}
                      options={[
                        {
                          value: '',
                          label: t(
                            'system.notificationSummaryEditor.theHubSDefaultVision',
                            "The hub's default vision profile",
                          ),
                        },
                        ...visionProfiles.map((p) => ({
                          value: p.id,
                          label: `${p.name} · ${p.model}${p.enabled ? '' : ' · disabled'}`,
                        })),
                      ]}
                      onChange={(e) => patch({ aiProfileId: e.target.value })}
                      data-testid="summary-ai-profile"
                    />
                    <p className={DIGEST_HINT_CLASS}>
                      {profilesQuery.isError
                        ? t(
                            'system.notificationSummaryEditor.thisHubDidNotAnswer',
                            'This hub did not answer with a profile list — the digest will use whatever the AI addon resolves for the “ai-summary” consumer.',
                          )
                        : visionProfiles.length === 0
                          ? t(
                              'system.notificationSummaryEditor.noVisionCapableProfileOn',
                              'No vision-capable profile on this hub yet. Add one under AI → Profiles; until then the digest delivers without text.',
                            )
                          : t(
                              'system.notificationSummaryEditor.onlyVisionCapableProfilesAre',
                              'Only vision-capable profiles are offered — a vision call against a text profile is refused, never degraded.',
                            )}
                    </p>
                  </div>

                  <div>
                    <label className={DIGEST_LABEL_CLASS}>
                      {t('system.notificationSummaryEditor.answerIn', 'Answer in')}
                    </label>
                    <Select
                      value={form.aiLanguage}
                      disabled={!form.aiEnabled}
                      // `''` used to read "English (default)" beside an `en`
                      // that read "English": picking one moved the trigger by
                      // two words and looked like a click that never landed.
                      // The sentinel says what it DOES — it adds nothing to the
                      // prompt — so no two entries name the same language.
                      options={[
                        {
                          value: '',
                          label: t(
                            'system.notificationSummaryEditor.donTAskForA',
                            'Don’t ask for a language',
                          ),
                        },
                        ...SUMMARY_AI_LANGUAGES.map((l) => ({
                          value: l,
                          label: AI_LANGUAGE_LABELS[l],
                        })),
                      ]}
                      onChange={(e) => patch({ aiLanguage: parseAiLanguage(e.target.value) })}
                      data-testid="summary-ai-language"
                    />
                    <p className={DIGEST_HINT_CLASS}>
                      {t(
                        'system.notificationSummaryEditor.nothingIsAddedToThe',
                        'Nothing is added to the prompt unless you pick one, and these models answer in English on their own.',
                      )}
                    </p>
                  </div>
                </div>

                <div>
                  <label className={DIGEST_LABEL_CLASS}>
                    {t(
                      'system.notificationSummaryEditor.yourQuestionOptional',
                      'Your question (optional)',
                    )}
                  </label>
                  <Textarea
                    value={form.aiPrompt}
                    rows={3}
                    maxLength={SUMMARY_AI_MAX_PROMPT}
                    disabled={!form.aiEnabled}
                    onChange={(e) => patch({ aiPrompt: e.target.value })}
                    data-testid="summary-ai-prompt"
                    placeholder={t(
                      'system.notificationSummaryEditor.eGTellMeWhether',
                      'e.g. Tell me whether anybody approached the gate, and whether a parcel was left.',
                    )}
                    className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                  />
                  <p className={DIGEST_HINT_CLASS}>
                    {t(
                      'system.notificationSummaryEditor.leaveBlankForWhatHappened',
                      'Leave blank for “what happened during this period?”. Your words are the only free text the model is given: what the cameras are called and what the pipeline classified are reduced to plain labels first, and anything written INSIDE a frame — a sign, a plate, an overlay — is treated as scenery, never as an instruction.',
                    )}
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <DigestNumberField
                    label={t(
                      'system.notificationSummaryEditor.framesTheModelMayLook',
                      'Frames the model may look at',
                    )}
                    value={form.maxAiImages}
                    min={1}
                    max={SUMMARY_MAX_AI_IMAGES}
                    disabled={!form.aiEnabled}
                    onChange={(next) => patch({ maxAiImages: next ?? 1 })}
                    hint={t(
                      'system.notificationSummaryEditor.theHighestRankedTilesSent',
                      "The highest-ranked tiles, sent as ONE question. Bounded separately from the tile budget — one is bounded by pixels, the other by the model's time — and never larger than it.",
                    )}
                    testId="summary-max-ai-images"
                  />
                  <DigestNumberField
                    label={t(
                      'system.notificationSummaryEditor.timeLimitSeconds',
                      'Time limit (seconds)',
                    )}
                    value={form.aiTimeoutSeconds}
                    min={SUMMARY_AI_TIMEOUT_SECONDS_MIN}
                    max={SUMMARY_AI_TIMEOUT_SECONDS_MAX}
                    emptyPlaceholder="180"
                    disabled={!form.aiEnabled}
                    onChange={(next) => patch({ aiTimeoutSeconds: next })}
                    hint={t(
                      'system.notificationSummaryEditor.nobodyIsWaitingOnA',
                      'Nobody is waiting on a phone for a digest, so this is generous. At the bound the generation is cancelled, not merely abandoned.',
                    )}
                    testId="summary-ai-timeout"
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <DigestNumberField
                    label={t(
                      'system.notificationSummaryEditor.frameSizeSentPixels',
                      'Frame size sent (pixels)',
                    )}
                    value={form.aiMaxImagePx}
                    min={SUMMARY_AI_MAX_IMAGE_PX_MIN}
                    max={SUMMARY_AI_MAX_IMAGE_PX_MAX}
                    emptyPlaceholder="448"
                    disabled={!form.aiEnabled}
                    onChange={(next) => patch({ aiMaxImagePx: next })}
                    hint={t(
                      'system.notificationSummaryEditor.longestEdge448IsThe',
                      'Longest edge. 448 is the native tile size of these vision encoders — larger costs tokens and latency without adding detail the encoder can see.',
                    )}
                    testId="summary-ai-max-px"
                  />
                  <div>
                    <label className={DIGEST_LABEL_CLASS}>
                      {t(
                        'system.notificationSummaryEditor.ifTheModelGivesNo',
                        'If the model gives no answer',
                      )}
                    </label>
                    <Select
                      value={form.aiOnFailure}
                      disabled={!form.aiEnabled}
                      options={SUMMARY_AI_ON_FAILURE.map((v) => ({
                        value: v,
                        label: AI_ON_FAILURE_LABELS[v],
                      }))}
                      onChange={(e) => {
                        const next = parseAiOnFailure(e.target.value)
                        if (next !== undefined) patch({ aiOnFailure: next })
                      }}
                      data-testid="summary-ai-on-failure"
                    />
                    <p className={DIGEST_HINT_CLASS}>
                      {t(
                        'system.notificationSummaryEditor.aColdModelAnUnreachable',
                        'A cold model, an unreachable endpoint or an answer the hub cannot parse are all this case. The default delivers: the mosaic and the counts are worth more than silence, and a closed window does not come back.',
                      )}
                    </p>
                  </div>
                </div>
              </DigestSection>
            </TabsContent>

            <TabsContent value="delivery" className="space-y-3">
              <DigestSection title={t('system.notificationSummaryEditor.delivery', 'Delivery')}>
                <DigestTargetsField
                  targets={targets}
                  value={form.targetIds}
                  onChange={(next) => patch({ targetIds: next })}
                />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <DigestNumberField
                    label={t('system.notificationSummaryEditor.priority', 'Priority')}
                    value={form.priority}
                    min={1}
                    max={5}
                    onChange={(next) => patch({ priority: next ?? 3 })}
                    testId="summary-priority"
                  />
                  <DigestSwitchField
                    label={t(
                      'system.notificationSummaryEditor.deliverAWindowThatMatched',
                      'Deliver a window that matched nothing',
                    )}
                    checked={form.deliverEmpty}
                    onChange={(next) => patch({ deliverEmpty: next })}
                    hint={t(
                      'system.notificationSummaryEditor.offByDefaultANightly',
                      "Off by default: a nightly '0 events' is a line nobody reads, and it costs the lines beside it their reader.",
                    )}
                    testId="summary-deliver-empty"
                  />
                </div>
                <DigestTemplateFields
                  title={form.templateTitle}
                  body={form.templateBody}
                  onTitleChange={(next) => patch({ templateTitle: next })}
                  onBodyChange={(next) => patch({ templateBody: next })}
                  family="summary"
                  testIdPrefix="summary-template"
                />
                <p className={DIGEST_HINT_CLASS}>
                  <Trans
                    i18nKey="system.notificationSummaryEditor.aiToken"
                    values={{ token: '{{ai}}' }}
                    components={{ code: <code /> }}
                  />
                </p>
              </DigestSection>
            </TabsContent>
          </DialogBody>
        </Tabs>

        {/* Outside the tabs: a Save button that moved per tab would read as
            "save this tab". */}
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
              if (!isSummaryFormValid(form) || save.isPending) return
              save.mutate()
            }}
          >
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {rule === null
              ? t('system.notificationSummaryEditor.create', 'Create')
              : t('common.save', 'Save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
