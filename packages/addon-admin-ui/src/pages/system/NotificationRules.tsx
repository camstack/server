import { resolveParentNames } from '@camstack/ui-library'
/**
 * Notification RULES management page (slice D1 — list + CRUD shell).
 *
 * Mirrors the CRUD state machine of `NotificationTargets.tsx`:
 *   1. LIST  — `listRules` rows sorted by NAME: name, delivery/trigger, target
 *              count, a snooze `<Switch>` and an enabled `<Switch>`
 *              (`setRuleEnabled`), duplicate / delete. Clicking a row opens it.
 *   2. ADD   — `ItemFormDialog` hosting the rule SCAFFOLD form (name,
 *              enabled, trigger, target picker, priority, media, template).
 *   3. EDIT  — same modal pre-filled from the row; saves via `updateRule`.
 *   4. DELETE — the shared confirm dialog (`useConfirm`, `@camstack/ui-library`)
 *              → `deleteRule`.
 *
 * Open state is URL-owned via `useItemFormUrl({ editKey: 'rule' })` so deep
 * links stay `?rule=<id>` / `?rule=new` (create uses `openEdit('new')` — one
 * key for both, not `?new=1`). `?editTab=` and `?section=` stay beside it
 * through `useUrlQueryParam` so they share the same replaceState writer.
 *
 * All rule mutations go through `system.trpcClient.notificationRules.*`
 * (createRule / updateRule are the first `caller:'required'` adopters — the
 * hub injects the caller identity, the client sends none).
 */

import type {
  NcConditionDescriptor,
  NcRule,
  NcTaxonomy,
  NcTemplateVarContext,
  NcTestResult,
  Target,
} from '@camstack/types'
import {
  AlarmStateSchema,
  DeviceType,
  imageModesForKind,
  isDoPickerDeviceType,
  NC_GROUPING_DEFAULT_SEC,
  NC_GROUPING_MAX_SEC,
  NC_GROUPING_MIN_SEC,
  ruleDeviceCompatCapQueries,
  ruleKindOf,
  ruleKindSpec,
  ruleTriggerZoneIds,
  subjectHasPath,
  stateVocabularyFor,
  systemFamilyOfKind,
} from '@camstack/types'
import {
  Badge,
  Button,
  ErrorBox,
  Input,
  ItemFormDialog,
  NotificationTargetsField,
  OptionSelect,
  Select,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useDeviceManagerListAll,
  useItemFormUrl,
  useNotificationRulesCreateSequence,
  useNotificationRulesListSequences,
  useSystem,
  useUrlQueryParam,
} from '@camstack/ui-library'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertCircle, BellRing, CheckCircle, FlaskConical, Loader2, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { AdminPage } from '../../components/AdminPage'
import { TemplateField, TemplatePreview } from '../../components/notifications/TemplateField'
import { varsForContext } from '../../components/notifications/template-field.helpers'
import { useTemplateCatalog } from '../../components/notifications/use-template-catalog'
import { useScenesFeed } from '../../hooks/use-scenes-feed'
import { NotificationRuleActions } from './NotificationRuleActions'
import { formToActions } from './notification-rule-actions'
import {
  type RuleCameraOption,
  RuleConditionsAdvancedFields,
  RuleConditionsEditor,
} from './NotificationRuleConditions'
import { NotificationRuleDeviceScope } from './NotificationRuleDevices'
import { useRuleLastRuns } from './NotificationRuleLastRun'
import { NotificationRuleSnoozeControl } from './NotificationRuleSnoozeControl'
import { useRuleSnoozes } from './NotificationRuleSnoozeSwitch'
import { NotificationPruneBanner } from './NotificationPruneBanner'
import { NotificationRuleStatus } from './NotificationRuleStatus'
import { NotificationRuleTestButton } from './NotificationRuleTestButton'
import { NotificationSnoozes } from './NotificationSnoozes'
import { useProducerRulesHost } from './NotificationProducerRules'
import {
  CREATE_RULE_TYPE_OPTIONS,
  type CreateRuleType,
  isEventCreateType,
  isProducerAreaKey,
  isRuleSectionArea,
  parseRulesArea,
  producerAreaOf,
  type RulesAreaKey,
  visibleRulesAreas,
} from './notification-rules-area'
import { columnsForArea, minWidthForArea } from './unified-rules-columns'
import {
  countForArea,
  rowsForArea,
  type UnifiedRuleBags,
  type UnifiedRuleRow,
} from './unified-rules-model'
import type { RuleColumnsDeps } from './NotificationRuleColumns'
import type { GateableDevice, GateableScene } from './notification-condition-widgets'
import {
  applyDeliveryChoice,
  buildRuleClears,
  buildRuleInput,
  conditionTabLabel,
  changeSystemEventFamily,
  DEFAULT_NC_RULE_TAB,
  deliveryChoiceOf,
  deliveryChoicesFor,
  droppedConditions,
  emptyRuleForm,
  formScopedDeviceIds,
  isRecognisedDelivery,
  isRuleEditable,
  isRuleFormValid,
  formStepsForSnooze,
  isRuleSnoozeExempt,
  isSystemDelivery,
  NC_CLIP_PROFILE_OPTIONS,
  NC_CLIP_SPEED_OPTIONS,
  NC_COOLDOWN_GRANULARITY_OPTIONS,
  NC_COOLDOWN_MAX_SEC,
  NC_COOLDOWN_SCOPE_OPTIONS,
  NC_DEFAULT_SNOOZE_MINUTES,
  NC_IMAGE_OPTIONS,
  NC_LINKED_CAMERA_OPTIONS,
  NC_PRIORITY_OPTIONS,
  NC_RULE_SECTIONS,
  NC_SNOOZE_BUTTON_CHOICES,
  type NcRuleFormState,
  type NcRuleSectionKey,
  type NcRuleSeed,
  type NcRuleTabKey,
  parseClipProfile,
  parseClipSpeed,
  parseCooldown,
  parseCooldownGranularity,
  parseCooldownScope,
  parseDeliveryChoice,
  parseGroupingSec,
  parseLinkedCameras,
  parseMediaImage,
  parseRuleTab,
  ruleFormProblems,
  rulePreservedFields,
  isStateSummaryForm,
  summaryTemplateWarning,
  ruleScopeExceptOffered,
  ruleSeedForSection,
  ruleTabsFor,
  ruleToForm,
  snoozeChoiceLabel,
  verdictApplies,
  withLocalConditionDescriptors,
} from './notification-rules.helpers'
import { SystemFamilySelect } from './notification-system-event-field'
import { SystemEventDeliveryField } from './NotificationSystemEventDelivery'
import type { RuleDeviceOption } from './rule-device-filter'
import { ruleLastRunCell } from './notification-rule-last-run'
import { type DeviceFleetView, fleetViewOf } from './device-fleet-view'
import { ruleScopeList } from './rule-scope-model'
import { zoneCameraIds } from './zone-scope-items'
import { NcListEmpty, NcListLoading, NcListTable } from './notification-list-chrome'

/**
 * Query keys shared with the SIMULATE tab.
 *
 * Exported rather than re-declared there: the rules, targets, catalog and
 * camera answers are the same answers, and two keys for one question means the
 * operator pays for the same round-trip twice and can see two different
 * vocabularies on two tabs of one page.
 */
export const RULES_QUERY_KEY = ['notificationRules', 'listRules'] as const
export const TARGETS_QUERY_KEY = ['notificationOutput', 'listTargets', 'forRules'] as const
export const CATALOG_QUERY_KEY = ['notificationRules', 'getConditionCatalog'] as const

/** What `getConditionCatalog` returns: the condition surface plus the picker
 *  vocabulary those conditions draw on. `taxonomy` is optional — a hub that
 *  predates it sends none and every list condition stays free-text. */
export interface NcConditionCatalogResult {
  readonly catalog: readonly NcConditionDescriptor[]
  readonly taxonomy?: NcTaxonomy
}
/**
 * The fan-out over the fleet's runtime state. NOT a fleet key: the fleet itself
 * is read through `useDeviceManagerListAll`, whose key the D274 window and the
 * `[['deviceManager']]` invalidations both match. The two private
 * `['deviceManager','listAll',…]` keys that used to live here matched NEITHER.
 */
const GATEABLE_QUERY_KEY = ['deviceManager', 'gateableDevices'] as const

/** The alarm panel's own vocabulary — the one string-valued state with a known
 *  closed set. Everything else is derived from the device's live slice. */
const ALARM_STATES: readonly string[] = AlarmStateSchema.options

type EditorState =
  | { readonly mode: 'closed' }
  /** `seed` is present only for a NEW rule started from a section (never on an
   *  edit, where the stored rule is the seed). */
  | { readonly mode: 'form'; readonly rule: NcRule | null; readonly seed?: NcRuleSeed }

export interface NotificationRulesPageProps {
  /**
   * Hand a rule to the SIMULATE tab, prefilled from what it would match.
   *
   * Supplied by the tab host (`Notifications.tsx`), which owns the `?tab=`
   * coordination — this page must not reach for the router itself, and a page
   * embedded without a simulator simply renders no Test button rather than a
   * button that does nothing.
   */
  readonly onSimulateRule?: (rule: NcRule) => void
  /**
   * Open the History tab filtered on this rule. Supplied by the tab host for
   * the same reason as `onSimulateRule`: the host owns the URL. Absent ⇒ no
   * History button.
   */
  readonly onOpenHistory?: (rule: NcRule) => void
  /** Page-header New rule on All — open the type picker once, then clear. */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
  /** Page-header Add on a typed section — create that type once, then clear. */
  readonly createTypeRequested?: CreateRuleType | null
  readonly onCreateTypeConsumed?: () => void
  /**
   * When true, create controls live on the Notifications page header — do not
   * render a local Add (embedded under SectionedPage). Default false so a
   * standalone mount (specs) still has a New rule control.
   */
  readonly headerOwnsCreate?: boolean
}

export function NotificationRulesPage({
  onSimulateRule,
  onOpenHistory,
  createRequested = false,
  onCreateConsumed,
  createTypeRequested = null,
  onCreateTypeConsumed,
  headerOwnsCreate = false,
}: NotificationRulesPageProps = {}) {
  const system = useSystem()
  const { t } = useTranslation()
  // `?rule=` owns the editor (edit id or the literal `new`). Same writer as
  // `?section=` / `?editTab=` so a section change cannot resurrect a stale
  // `rule` from a parallel react-router snapshot.
  const {
    state: formUrl,
    openEdit: openRuleUrl,
    close: closeRuleUrl,
  } = useItemFormUrl({ editKey: 'rule' })
  const [sectionParam, setSectionParam] = useUrlQueryParam('section')
  const [editTabParam, setEditTabParam] = useUrlQueryParam('editTab')
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })
  const [typePickerOpen, setTypePickerOpen] = useState(false)
  // Area is the URL — deep links and the old top-level Summaries /
  // Timelapses tabs land here via `?tab=rules&section=…`. Derived, not
  // mirrored: a useState seeded once left back/forward on a stale strip.
  const area: RulesAreaKey = parseRulesArea(sectionParam) ?? 'all'

  const setArea = (next: RulesAreaKey): void => {
    setSectionParam(next === 'all' ? null : next)
  }

  const rulesQuery = useQuery({
    queryKey: RULES_QUERY_KEY,
    queryFn: async (): Promise<readonly NcRule[]> => {
      const res = await system.trpcClient.notificationRules.listRules.query({})
      return res.rules
    },
  })

  // Restore an open editor from `?rule=` after a refresh / deep link.
  // Create (`?rule=new`) is never restored — the form needs a local seed the
  // URL does not carry (same as before this hook migration).
  const restoredRuleRef = useRef<string | null>(null)
  useEffect(() => {
    if (editor.mode !== 'closed') return
    if (formUrl.mode !== 'edit') {
      if (formUrl.mode === 'closed') restoredRuleRef.current = null
      return
    }
    const ruleId = formUrl.id
    if (ruleId === 'new') return
    if (restoredRuleRef.current === ruleId) return
    const hit = rulesQuery.data?.find((r) => r.id === ruleId)
    if (hit === undefined || !isRuleEditable(hit)) return
    restoredRuleRef.current = ruleId
    setEditor({ mode: 'form', rule: hit })
  }, [editor.mode, formUrl, rulesQuery.data])

  const targetsQuery = useQuery({
    queryKey: TARGETS_QUERY_KEY,
    queryFn: (): Promise<readonly Target[]> =>
      system.trpcClient.notificationOutput.listTargets.query({}),
  })

  // The catalog says WHICH conditions exist; the taxonomy says which VALUES
  // each one accepts. Both come from one call, so a picker can never render
  // against a stale vocabulary.
  const catalogQuery = useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: (): Promise<NcConditionCatalogResult> =>
      system.trpcClient.notificationRules.getConditionCatalog.query({}),
  })

  /**
   * ONE fleet read for all three pickers below.
   *
   * These used to be three separate `trpcClient.deviceManager.listAll.query()`
   * calls under three private keys — two of them at the FULL projection, which
   * is 1 019 rows with every device's `config` blob and a settings-store read
   * per device. A private key is invisible twice over: `applyFleetQueryDefaults`
   * registers the 30 s window on the tRPC key PREFIX (D274) and the ~20
   * `[['deviceManager']]` invalidations match the same prefix, so neither
   * reached `['deviceManager','listAll','forRules']`. Renaming a camera left
   * this picker showing the old name until the tab was remounted.
   *
   * The generated hook fixes all of that by construction, and shares the cache
   * entry the sidebar search keeps warm — so this page costs zero fleet
   * round-trips on a warm client.
   *
   * `slim` is safe BY FIELD: the three consumers below read `id`, `name`,
   * `type` and `location`. Slim drops `config`, `metadata` and `sourceInfo`,
   * none of which is read here.
   */
  const fleetQuery = useDeviceManagerListAll({ projection: 'slim' })
  /** ONE read for every row's "Last run" — never a history query per rule. */
  const lastRuns = useRuleLastRuns()
  const fleet = useMemo(() => fleetQuery.data ?? [], [fleetQuery.data])
  /** The fleet with whether it ANSWERED: `fleet` is `[]` both before the answer
   *  and on an empty hub, and only the answer may call a selected id removed
   *  (D315). */
  const fleetView = fleetViewOf(fleetQuery)

  /**
   * Devices the `deviceState` gate can read, with each one's state vocabulary.
   *
   * Resolved with the SAME table the engine uses (`stateVocabularyFor`), so the
   * picker can never offer a value the gate would not recognise — the
   * triple-mirror drift that emptied the rule editor twice, closed by
   * construction. A device with no gateable capability is left OUT of the list
   * rather than offered and unusable.
   *
   * The per-device `loadRuntimeState` fan-out below is UNCHANGED and is still a
   * sequential round-trip per device. Keyed on the id list so a fleet change
   * re-runs it, exactly as re-fetching the fleet inside the body used to.
   */
  const fleetIds = useMemo(() => fleet.map((d) => d.id), [fleet])
  const gateableQuery = useQuery({
    queryKey: [...GATEABLE_QUERY_KEY, fleetIds],
    enabled: fleetIds.length > 0,
    queryFn: async (): Promise<readonly GateableDevice[]> => {
      const out: GateableDevice[] = []
      for (const d of fleet) {
        const runtime = await system.trpcClient.deviceManager.loadRuntimeState.query({
          deviceId: d.id,
        })
        const states = stateVocabularyFor(runtime, ALARM_STATES)
        if (states.length > 0) out.push({ id: d.id, name: d.name, states })
      }
      return out
    },
    staleTime: 60_000,
  })

  // EVERY device: a rule actuates locks, lights and alarm panels, and none of
  // those are cameras. Separate from `cameras`, which drives the device
  // CONDITION and is deliberately cameras-only.
  const actuatable = useMemo((): readonly RuleDeviceOption[] => {
    // Resolved from the SAME listing, so the container costs no query:
    // `parentDeviceId` is already on the slim projection above.
    // Containers are parent grouping nodes — Do / Sequences actuate children.
    const parents = resolveParentNames(fleet)
    return fleet
      .filter((d) => isDoPickerDeviceType(String(d.type)))
      .map((d) => {
        const parentName = parents.get(d.id)
        return {
          id: d.id,
          name: d.name,
          type: String(d.type),
          location: d.location ?? null,
          ...(parentName !== undefined ? { parentName } : {}),
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [fleet])

  // `type === Camera`, NOT the server's `isCamera` filter: `isCamera` means
  // "exposes getStreamSources()" for a hub-live device and is derived from the
  // persisted type only for forked-worker devices, so the two can disagree.
  // Pushing the filter server-side would silently change which rows appear.
  const cameras = useMemo(
    (): readonly RuleCameraOption[] =>
      fleet.filter((d) => d.type === DeviceType.Camera).map((d) => ({ id: d.id, name: d.name })),
    [fleet],
  )

  /**
   * Scenes the `scene` gate can pick, with the state each one is in RIGHT NOW.
   *
   * Reuses `useScenesFeed`, the same per-camera fan-out Library → Scenes runs
   * on — one source, so the picker can never disagree with the page the
   * operator just came from. A camera whose provider cannot answer contributes
   * no scenes rather than an empty list that reads as "this camera has none";
   * the feed counts those separately and the widget's own empty state says so.
   */
  const sceneCameraIds = useMemo(() => cameras.map((c) => c.id), [cameras])
  const scenesFeed = useScenesFeed(sceneCameraIds)
  const gateableScenes = useMemo((): readonly GateableScene[] => {
    const nameById = new Map(cameras.map((c) => [c.id, c.name]))
    return scenesFeed.results.flatMap((result) =>
      result.monitors.map((monitor) => ({
        sceneId: monitor.id,
        deviceId: result.deviceId,
        cameraName: nameById.get(result.deviceId) ?? `#${String(result.deviceId)}`,
        label: monitor.label,
        verdict: monitor.verdict,
        latched: monitor.latched,
        emit: monitor.emit,
      })),
    )
  }, [scenesFeed.results, cameras])

  const targetNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of targetsQuery.data ?? []) m.set(t.id, t.name)
    return m
  }, [targetsQuery.data])

  const setEnabled = useMutation({
    mutationFn: (vars: { readonly ruleId: string; readonly enabled: boolean }) =>
      system.trpcClient.notificationRules.setRuleEnabled.mutate(vars),
    onSuccess: () => void rulesQuery.refetch(),
  })

  const deleteRule = useMutation({
    mutationFn: (ruleId: string) =>
      system.trpcClient.notificationRules.deleteRule.mutate({ ruleId }),
    onSuccess: () => void rulesQuery.refetch(),
  })
  /** The Snooze column's windows — the "Silenced right now" panel's key. */
  const snoozes = useRuleSnoozes()
  const sequencesQuery = useNotificationRulesListSequences({})
  const sequences = sequencesQuery.data?.sequences ?? []
  const createSequence = useNotificationRulesCreateSequence()

  const rules = rulesQuery.data ?? []

  // The scheduled producers (Summaries / Timelapses / Calendar events): their
  // lists, mutations, editors and confirm dialogs. The table below is ONE
  // table over event rules AND these rows — see `rowsForArea`.
  const producers = useProducerRulesHost({
    cameras,
    fleet: fleetView,
    targets: targetsQuery.data ?? [],
    taxonomy: catalogQuery.data?.taxonomy,
  })
  const bags: UnifiedRuleBags = {
    events: rules,
    summaries: producers.summaries,
    timelapses: producers.timelapses,
    calendarEvents: producers.calendarEvents,
  }

  // One count per strip entry, from the SAME function that selects the table's
  // rows — the badge and the table can never disagree.
  const countBySection = new Map<NcRuleSectionKey, number>(
    NC_RULE_SECTIONS.map((entry) => [entry.key, countForArea(entry.key, bags)]),
  )
  // "To recreate" (D637) is shown only while it holds a rule. Once its last
  // rule is deleted the tab goes, and the page falls back to All rather than
  // showing a section the strip no longer offers. Summaries / Timelapses /
  // Calendar events are always on the strip.
  const shownAreas = visibleRulesAreas(countBySection)
  const activeArea = shownAreas.find((s) => s.key === area) ?? shownAreas[0] ?? NC_RULE_SECTIONS[0]
  const producerArea = isProducerAreaKey(activeArea.key)
    ? producerAreaOf(activeArea.key)
    : undefined
  const ruleSectionKey = isRuleSectionArea(activeArea.key) ? activeArea.key : null
  // Row membership is computed ONCE (and sorted by NAME, R1 — the store answers
  // newest-first, which moves a rule every time it is saved).
  const areaRows = rowsForArea(activeArea.key, bags)
  // A mixed rule never reaches the dialog — not from Edit, not from Duplicate:
  // its `buildConditions` rewrites conditions by kind, so an open-and-save
  // would rewrite what a rule spanning families watches (D637).
  const closeEditor = (): void => {
    // Stamp the id we are leaving so a stale `?rule=` cannot reopen the
    // dialog through the deep-link restore effect — that race made Cancel
    // feel like it needed two presses.
    if (formUrl.mode === 'edit') restoredRuleRef.current = formUrl.id
    setEditor({ mode: 'closed' })
    closeRuleUrl()
    setEditTabParam(null)
  }

  const openEditor = (rule: NcRule): void => {
    if (!isRuleEditable(rule)) return
    // Duplicate seeds an empty id — treat as create in the URL (`?rule=new`).
    const urlId = rule.id.length > 0 ? rule.id : 'new'
    restoredRuleRef.current = urlId
    setEditor({ mode: 'form', rule })
    openRuleUrl(urlId)
    setEditTabParam(null)
  }

  const createByType = (type: CreateRuleType): void => {
    if (isEventCreateType(type)) {
      restoredRuleRef.current = 'new'
      setEditor({ mode: 'form', rule: null, seed: ruleSeedForSection(type) })
      openRuleUrl('new')
      setEditTabParam(null)
      return
    }
    // A producer opens its editor in place — the operator stays on the tab
    // (usually All) they chose "New rule" from.
    producers.create(type)
  }

  useEffect(() => {
    if (createTypeRequested === null) return
    createByType(createTypeRequested)
    onCreateTypeConsumed?.()
    // Intentionally only react to the page-header request pulse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createTypeRequested])

  useEffect(() => {
    if (!createRequested) return
    setTypePickerOpen(true)
    onCreateConsumed?.()
    // Intentionally only react to the page-header request pulse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequested])

  const openRow = (row: UnifiedRuleRow): void => {
    if (row.family === 'event') {
      openEditor(row.rule)
      return
    }
    producers.open(row)
  }

  const eventColumnDeps: RuleColumnsDeps = {
    targetNameById,
    snoozes,
    sequences,
    deletePending: deleteRule.isPending,
    onToggle: (rule, enabled) => setEnabled.mutate({ ruleId: rule.id, enabled }),
    // Duplicate: seed the form from this rule, but as a NEW rule (empty id)
    // with a distinguishable name.
    onOpen: openEditor,
    t,
    onDuplicate: (rule) => openEditor({ ...rule, id: '', name: `${rule.name} (copy)` }),
    onConfirmDelete: (rule) => deleteRule.mutate(rule.id),
    ...(onSimulateRule ? { onTest: onSimulateRule } : {}),
    lastRunOf: (ruleId) => ruleLastRunCell(lastRuns, ruleId),
    ...(onOpenHistory ? { onOpenHistory } : {}),
  }
  const columns = columnsForArea(activeArea.key, {
    event: eventColumnDeps,
    summary: producers.columnDeps.summary,
    timelapse: producers.columnDeps.timelapse,
    calendar: producers.columnDeps.calendar,
  })

  const pageBlurb = producerArea?.blurb ?? ('blurb' in activeArea ? activeArea.blurb : '')
  const creatable =
    producerArea !== undefined ? true : 'creatable' in activeArea ? activeArea.creatable : false

  const localCreate =
    headerOwnsCreate || !creatable ? null : area === 'all' ? (
      <Button
        size="sm"
        type="button"
        data-testid="rules-new-menu"
        onClick={() => setTypePickerOpen(true)}
      >
        <Plus className="h-3.5 w-3.5" />
        {t('system.notificationRules.newRule', 'New rule')}
      </Button>
    ) : producerArea !== undefined ? (
      <Button
        size="sm"
        type="button"
        onClick={() =>
          createByType(
            producerArea.key === 'summaries'
              ? 'summary'
              : producerArea.key === 'timelapses'
                ? 'timelapse'
                : 'calendar-events',
          )
        }
        data-testid={
          producerArea.key === 'summaries'
            ? 'summary-new'
            : producerArea.key === 'timelapses'
              ? 'timelapse-new'
              : 'calendar-events-new'
        }
      >
        <Plus className="h-3.5 w-3.5" />
        {producerArea.newLabel}
      </Button>
    ) : (
      <Button
        size="sm"
        type="button"
        onClick={() => createByType(activeArea.key as CreateRuleType)}
        data-testid={`rules-new-${activeArea.key}`}
      >
        <Plus className="h-3.5 w-3.5" />
        {'newRuleLabel' in activeArea
          ? activeArea.newRuleLabel
          : t('system.notificationRules.newRule', 'New rule')}
      </Button>
    )

  return (
    <AdminPage
      embedded
      icon={BellRing}
      title={t('system.notificationRules.rules', 'Rules')}
      subtitle={pageBlurb}
    >
      <div className="flex flex-col gap-3">
        {localCreate !== null ? <div className="flex justify-end">{localCreate}</div> : null}
        {/* AREAS. Event-driven rule sections share one store; Summaries and
          Timelapses are scheduled producers with their own stores. One strip
          keeps create/edit scanning the same way — never three top-level NC
          tabs that look like different products. */}
        <Tabs
          appearance="pills"
          value={activeArea.key}
          onValueChange={(next) => setArea(parseRulesArea(next) ?? area)}
        >
          <TabsList>
            {shownAreas.map((entry) => (
              <TabsTrigger key={entry.key} value={entry.key}>
                {entry.label}
                <span className="ml-1.5 text-[10px] text-foreground-subtle">
                  {countForArea(entry.key, bags)}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* A live silence is the first thing to see: it answers "why is that
          camera quiet?", and renders nothing when nothing is snoozed. */}
        <NotificationSnoozes rules={rules} />

        {producers.notices(activeArea.key)}

        {(rulesQuery.isLoading || producers.loading) && <NcListLoading />}

        {rulesQuery.isError && !rulesQuery.isLoading && (
          <ErrorBox
            title={t('system.notificationRules.failedToLoadRules', 'Failed to load rules')}
            message={
              rulesQuery.error instanceof Error
                ? rulesQuery.error.message
                : t('system.notificationRules.unknownError', 'Unknown error')
            }
            onRetry={() => void rulesQuery.refetch()}
          />
        )}

        {!rulesQuery.isLoading &&
          !producers.loading &&
          !rulesQuery.isError &&
          !producers.listFailed(activeArea.key) &&
          areaRows.length === 0 && (
            <NcListEmpty>
              {producerArea?.emptyHint ??
                ('emptyHint' in activeArea
                  ? activeArea.emptyHint
                  : t('system.notificationRules.noRulesYet', 'No rules yet.'))}
            </NcListEmpty>
          )}

        {areaRows.length > 0 && (
          <NcListTable<UnifiedRuleRow>
            columns={columns}
            rows={areaRows}
            rowKey={(r) => `${r.family}:${r.id}`}
            onRowClick={openRow}
            minWidthPx={minWidthForArea(activeArea.key)}
          />
        )}

        {editor.mode === 'form' && (
          <RuleFormDialog
            rule={editor.rule}
            {...(editor.seed ? { seed: editor.seed } : {})}
            targets={targetsQuery.data ?? []}
            actuatable={actuatable}
            fleet={fleetView}
            sequences={sequences}
            onCreateSequence={async (input) => {
              const res = await createSequence.mutateAsync({
                sequence: {
                  name: input.name,
                  ...(input.minDelaySec !== undefined ? { minDelaySec: input.minDelaySec } : {}),
                  actions: [...input.actions],
                },
              })
              await sequencesQuery.refetch()
              return res.sequence.id
            }}
            // Plus what this build can author against a hub whose train predates
            // the descriptor — otherwise `buildConditions` prunes to the served
            // catalog and an open-and-save STRIPS the condition from a rule the
            // running engine already evaluates.
            catalog={withLocalConditionDescriptors(catalogQuery.data?.catalog ?? [])}
            taxonomy={catalogQuery.data?.taxonomy}
            cameras={cameras}
            gateable={gateableQuery.data ?? []}
            gateableScenes={gateableScenes}
            initialEditTab={parseRuleTab(editTabParam ?? '') ?? DEFAULT_NC_RULE_TAB}
            onEditTabChange={(next) => setEditTabParam(next === DEFAULT_NC_RULE_TAB ? null : next)}
            onCancel={closeEditor}
            onSaved={() => {
              closeEditor()
              void rulesQuery.refetch()
            }}
          />
        )}

        {producers.overlays}

        {typePickerOpen ? (
          <RuleTypePicker
            onCancel={() => setTypePickerOpen(false)}
            onPick={(type) => {
              setTypePickerOpen(false)
              createByType(type)
            }}
          />
        ) : null}
      </div>
    </AdminPage>
  )
}

/** Pre-modal: pick a rule type before opening the matching editor (NC target KindPicker). */
function RuleTypePicker({
  onPick,
  onCancel,
}: {
  readonly onPick: (type: CreateRuleType) => void
  readonly onCancel: () => void
}) {
  const { t } = useTranslation()
  return (
    <ItemFormDialog
      open
      onClose={onCancel}
      title={t('system.notificationRules.chooseARuleType', 'Choose a rule type')}
      width="lg"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {CREATE_RULE_TYPE_OPTIONS.map((opt) => (
          // ui-check-ok: type tile — label+hint grid, not a toolbar Button
          <button
            key={opt.type}
            type="button"
            data-testid={`rules-new-${opt.type}`}
            title={opt.hint}
            onClick={() => onPick(opt.type)}
            className="flex flex-col items-start gap-1 rounded-lg border border-border bg-surface px-3 py-3 text-left text-xs hover:border-primary/50 hover:bg-surface-hover transition-colors"
          >
            <span className="font-medium text-foreground">{opt.label}</span>
            <span className="text-[10px] font-normal text-foreground-subtle">{opt.hint}</span>
          </button>
        ))}
      </div>
    </ItemFormDialog>
  )
}

// ── Add / edit modal ────────────────────────────────────────────────

/** The user fields the "Notify users" picker needs. */
interface RuleFormUser {
  readonly id: string
  readonly username: string
  readonly isAdmin: boolean
}

interface RuleFormDialogProps {
  /** The rule being edited, or null for a new rule. A rule with an empty `id`
   *  is a duplicate seed → treated as NEW (createRule). */
  readonly rule: NcRule | null
  /** What a NEW rule opens on — the trigger AND the condition that makes it the
   *  kind of rule the section is about (absent on an edit). */
  readonly seed?: NcRuleSeed
  readonly targets: readonly Target[]
  readonly catalog: readonly NcConditionDescriptor[]
  /** Picker vocabulary; absent on a hub that predates it → free-text inputs. */
  readonly taxonomy: NcTaxonomy | undefined
  readonly cameras: readonly RuleCameraOption[]
  readonly gateable: readonly GateableDevice[]
  /** Scenes the `scene` gate can read, with each one's live state. */
  readonly gateableScenes: readonly GateableScene[]
  /** EVERY device, not just cameras — a rule actuates locks, lights and panels,
   *  none of which are cameras. */
  readonly actuatable: readonly RuleDeviceOption[]
  /** The fleet behind `cameras` and `actuatable`, and whether it ANSWERED
   *  (D315). */
  readonly fleet: DeviceFleetView
  readonly sequences: readonly import('@camstack/types').NcSharedSequence[]
  readonly onCreateSequence: (input: {
    readonly name: string
    readonly minDelaySec?: number
    readonly actions: readonly import('@camstack/types').NcRuleAction[]
  }) => Promise<string>
  readonly initialEditTab?: NcRuleTabKey
  readonly onEditTabChange?: (tab: NcRuleTabKey) => void
  readonly onSaved: () => void
  readonly onCancel: () => void
}

function RuleFormDialog({
  rule,
  seed,
  targets,
  catalog,
  taxonomy,
  cameras,
  gateable,
  gateableScenes,
  actuatable,
  fleet,
  sequences,
  onCreateSequence,
  initialEditTab = DEFAULT_NC_RULE_TAB,
  onEditTabChange,
  onSaved,
  onCancel,
}: RuleFormDialogProps) {
  const system = useSystem()
  const { t } = useTranslation()
  const isExisting = rule != null && rule.id.length > 0
  // The form as OPENED — the saved rule, or a new rule's seed. Kept apart from
  // `form` because a device picker whose empty value means "all" warns from
  // it: a tab switch remounts the picker, and a warning seeded only from its
  // own mount forgot that this save widens the rule to every device.
  const [opened] = useState<NcRuleFormState>(() =>
    rule ? ruleToForm(rule) : emptyRuleForm(seed?.delivery, seed?.conditions),
  )
  const [form, setForm] = useState<NcRuleFormState>(opened)
  const [error, setError] = useState<string | null>(null)
  /** Blocking reasons stay hidden on a new rule until the first Create click. */
  const [problemsRevealed, setProblemsRevealed] = useState(isExisting)
  const [testResults, setTestResults] = useState<readonly NcTestResult[] | null>(null)
  const [tab, setTab] = useState<NcRuleTabKey>(initialEditTab)

  const patch = (next: Partial<NcRuleFormState>): void => setForm((prev) => ({ ...prev, ...next }))

  // Fields the form does not author come from the rule being edited OR
  // duplicated — a duplicate seed has an empty id but every other field.
  const preserve = rule ? rulePreservedFields(rule) : undefined

  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      const input = buildRuleInput(form, preserve, catalog)
      if (isExisting && rule) {
        const clears = buildRuleClears(form, catalog)
        await system.trpcClient.notificationRules.updateRule.mutate({
          ruleId: rule.id,
          patch: input,
          ...(clears.length > 0 ? { clear: clears } : {}),
        })
      } else {
        await system.trpcClient.notificationRules.createRule.mutate({ rule: input })
      }
    },
    onSuccess: onSaved,
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Save failed'),
  })

  const testRun = useMutation({
    mutationFn: async (): Promise<readonly NcTestResult[]> => {
      const input = buildRuleInput(form, preserve, catalog)
      const res = await system.trpcClient.notificationRules.testRule.mutate({
        rule: input,
        lookbackMinutes: 60,
      })
      return res.results
    },
    onMutate: () => setTestResults(null),
    onSuccess: (results) => setTestResults(results),
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Test failed'),
  })

  const targetNames = form.targetIds.map((id) => targets.find((t) => t.id === id)?.name ?? id)

  // Read through `system.trpcClient` like every other query on this page: the
  // generated React hook needs a tRPC provider this page never mounts in, so
  // using it made the dialog throw the moment it opened.
  const users = useQuery({
    queryKey: ['userManagement', 'listUsers'],
    queryFn: (): Promise<readonly RuleFormUser[]> =>
      system.trpcClient.userManagement.listUsers.query(),
  }).data
  const userOptions = useMemo(
    () =>
      (users ?? []).map((user) => ({
        value: user.id,
        label: user.username,
        ...(user.isAdmin ? { badge: 'admin' } : {}),
      })),
    [users],
  )

  // The trigger CHOICE (D692): `immediate-grouped` is the grouped presentation of
  // `immediate`, offered only where `ruleGroupingApplies` allows it.
  const deliveryChoice = deliveryChoiceOf(form)
  const groupedSelected = deliveryChoice === 'immediate-grouped'
  const groupingSecN = String(form.groupingSec ?? NC_GROUPING_DEFAULT_SEC)
  const deliveryChoices = deliveryChoicesFor(form).map((o) => ({
    ...o,
    label:
      o.value === 'immediate-grouped' ? t('notificationRules.grouping.choice', o.label) : o.label,
    hint:
      o.value === 'immediate-grouped'
        ? t('notificationRules.grouping.hint', {
            n: groupingSecN,
            defaultValue:
              'Immediate, grouped — waits up to {{n}} s for subjects to be recognised, then sends one message with a mosaic, one picture per subject. Closes earlier when every subject is final.',
          }).replaceAll('{{n}}', groupingSecN)
        : o.hint,
  }))
  const deliveryHint = deliveryChoices.find((o) => o.value === deliveryChoice)?.hint
  // What this form would ship that can never fire — the same list that disables
  // the Save button (`isRuleFormValid`), rendered so the operator can read it.
  const problems = ruleFormProblems(form, preserve)
  const systemRule = isSystemDelivery(form.delivery)
  // WHICH KIND of rule this is — the trigger AND its discriminating condition.
  // Everything per-kind on this dialog (the tab label, which media controls
  // exist, which conditions are offered) reads from here rather than from a
  // handful of `if (delivery === …)` branches. See `@camstack/types` `rule-kinds.ts`.
  const kind = ruleKindOf(form)
  const kindSpec = ruleKindSpec(kind)
  // D897: the picture modes this kind can honour, and whether the rule fires
  // on a zone (the only rule the trigger-zone flag is offered on).
  const imageModes = imageModesForKind(kind)
  const imageOptions = NC_IMAGE_OPTIONS.filter((o) => imageModes.includes(o.value))
  const zoneTrigger = ruleTriggerZoneIds(form.conditions).length > 0
  const systemFamily = systemFamilyOfKind(kind)
  // WHICH devices the Devices tab offers (operator ruling, 2026-10-01): never
  // a hard-coded list, derived from the fleet's own bound capabilities
  // (`ruleDeviceCompatCapQueries` — the SAME table the save-time guard reads;
  // one call per query, unioned, because the wire method takes ≤16 names and
  // a sensor rule asks for its 16 eventful caps PLUS the camera cap, D630 §6).
  // `null` means no filter for this kind (every system family; the Devices
  // tab is not even shown for one). Unanswered or failed stays the full
  // `actuatable` list rather than claiming "no devices" (D315); a selected id
  // is never dropped by this read (D49) — see `ruleScopeList(form.deviceScope)`.
  const compatQueries = ruleDeviceCompatCapQueries(kind)
  const compatDevicesQuery = useQuery({
    queryKey: ['deviceManager', 'listDeviceIdsByCaps', 'nc-rule-devices', compatQueries ?? []],
    enabled: compatQueries !== null,
    queryFn: async (): Promise<ReadonlySet<number>> => {
      const answers = await Promise.all(
        (compatQueries ?? []).map((capNames) =>
          system.trpcClient.deviceManager.listDeviceIdsByCaps.query({ capNames: [...capNames] }),
        ),
      )
      return new Set(answers.flat())
    },
    staleTime: 60_000,
  })
  const scopedDevices = useMemo((): readonly RuleDeviceOption[] => {
    if (compatQueries === null || compatDevicesQuery.data === undefined) return actuatable
    const compatible = compatDevicesQuery.data
    const selected = new Set(ruleScopeList(form.deviceScope))
    return actuatable.filter((d) => compatible.has(d.id) || selected.has(d.id))
  }, [actuatable, compatQueries, compatDevicesQuery.data, form.deviceScope])
  /** Pending only while a filter APPLIES and has not answered yet — a kind
   *  with no filter (`compatQueries === null`) is never "loading" for this. */
  const scopedDevicesLoading = compatQueries !== null && compatDevicesQuery.isLoading
  /** A FAILED read falls back to the unfiltered list above, and SAYS so: the
   *  operator is then looking at every device, not the narrowed list, and the
   *  hub's save-time guard is the only check left. */
  const scopedDevicesFailed = compatQueries !== null && compatDevicesQuery.isError
  const templateCatalog = useTemplateCatalog()
  const ruleTemplateContext = (field: 'title' | 'body'): NcTemplateVarContext => ({
    family: 'rule',
    field,
    kind,
    delivery: form.delivery,
    // A summary row speaks its own vocabulary (D647).
    ...(isStateSummaryForm(form) ? { systemEventDelivery: 'summary' as const } : {}),
    ...(form.conditions.systemEvent
      ? { systemEventKinds: [...form.conditions.systemEvent.kinds] }
      : {}),
  })
  const varsFor = (field: 'title' | 'body') =>
    templateCatalog.data
      ? varsForContext(templateCatalog.data, ruleTemplateContext(field))
      : undefined
  // Conditions the rule CARRIES that its kind cannot use. Named before Save, not
  // dropped in silence: each is a condition the engine fails closed on for this
  // subject, so the rule is enabled and permanently silent, and dropping it is
  // what makes it fire again.
  const dropped = droppedConditions(form)
  // Derived on every render from what the operator is authoring RIGHT NOW:
  // adding an `alarm-panel` step must disable the snooze controls in the same
  // breath, or the dialog would offer a silence the hub refuses.
  const snoozeExempt = isRuleSnoozeExempt(
    form.conditions,
    formStepsForSnooze(form.actions, sequences),
  )
  // Does this rule's match depend on RECOGNITION? Derived exactly as the engine
  // derives it (`ruleHasRecognitionScope`), so the two grouping hints show in
  // precisely the cases where they apply. PRESENT, not non-empty: an empty
  // identity list is "only known faces" and waits like a named one.
  const ruleAwaitsRecognition =
    form.conditions.identities !== undefined || form.conditions.plates !== undefined

  // Which tabs this trigger actually has. Computed, never stored: the operator
  // can switch the trigger with a tab open that the new trigger does not have,
  // and an `activeTab` derived from the visible set cannot strand the dialog on
  // a blank panel.
  const visibleTabs = ruleTabsFor(form.delivery, form.conditions)
  const activeTab = visibleTabs.some((entry) => entry.key === tab) ? tab : DEFAULT_NC_RULE_TAB

  /*
   * THE NO-SILENT-COERCE GUARD.
   *
   * A trigger this build has no option for cannot be EDITED, only shown. The
   * failure it replaces was specific and destructive: the trigger `<Select>` is
   * controlled by `form.delivery`, and a controlled select whose value matches
   * no option renders the FIRST option instead — so a live `system-event` rule
   * opened here displayed "Immediate", and the next change event on any field
   * saved it as an immediate detection rule. Silently: the operator saw a rule
   * they had authored and a form that looked normal.
   *
   * The rule is therefore: an unrecognised trigger renders READ-ONLY. No
   * select, no save button, nothing that could write. It is a version gap
   * (a hub newer than this bundle), not a corrupt rule — so it says which
   * trigger it is and preserves the rule exactly as stored.
   */
  if (!isRecognisedDelivery(form.delivery)) {
    return <UnsupportedTriggerDialog rule={rule} onCancel={onCancel} />
  }

  // Tabs wrap the dialog so the strip can live in `beforeBody` (pinned) while
  // the panels scroll inside ItemFormDialog's DialogBody — React context
  // crosses the dialog portal.
  return (
    <Tabs
      value={activeTab}
      onValueChange={(next) => {
        const parsed = parseRuleTab(next)
        if (parsed === undefined) return
        setTab(parsed)
        onEditTabChange?.(parsed)
      }}
    >
      <ItemFormDialog
        open
        onClose={onCancel}
        title={
          isExisting
            ? t('system.notificationRules.edit', 'Edit {{name}}', { name: rule?.name })
            : t('system.notificationRules.newNotificationRule', 'New notification rule')
        }
        icon={BellRing}
        error={error}
        width="lg"
        testId="rule-form-dialog"
        beforeBody={
          <>
            {/* WHAT THIS RULE IS DOING RIGHT NOW — under the title, above the
                tabs, because it is the first thing an operator opening an
                occupancy or a timelapse rule wants and the rule's own fields
                cannot answer it. Renders nothing for a kind with no live
                state, and nothing at all for an unsaved rule. */}
            {isExisting && rule && (
              <div className="mb-3 space-y-2">
                <NotificationPruneBanner
                  kind="rule"
                  ruleId={rule.id}
                  enabled={rule.enabled}
                  updatedAt={rule.updatedAt}
                />
                <NotificationRuleStatus
                  ruleId={rule.id}
                  cameraName={(deviceId) =>
                    cameras.find((c) => c.id === deviceId)?.name ??
                    t('system.notificationRuleStatus.cameraFallback', { deviceId })
                  }
                />
              </div>
            )}
            {/* Above the scroller: switching tab is how you reach half this
                form. It scrolls SIDEWAYS on its own when six tabs do not fit. */}
            <TabsList className="mb-3">
              {visibleTabs.map((entry) => (
                <TabsTrigger key={entry.key} value={entry.key}>
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </>
        }
        footer={
          <div className="flex w-full flex-col gap-3">
            {dropped.length > 0 && (
              <div
                data-testid="rule-form-dropped"
                className="rounded-md border border-border bg-surface-subtle px-3 py-2 text-[11px] text-foreground-subtle space-y-1 text-left"
              >
                <p className="text-foreground">
                  {t('system.notificationRules.savingDrops', { count: dropped.length })}
                </p>
                {dropped.map((entry) => (
                  <p key={entry.conditionId}>
                    <span className="text-foreground">{entry.conditionId}</span> — {entry.reason}
                  </p>
                ))}
              </div>
            )}
            {problemsRevealed && problems.length > 0 ? (
              <div
                data-testid="rule-form-problems"
                className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning space-y-1 text-left"
              >
                {problems.map((problem) => (
                  <p key={problem}>{problem}</p>
                ))}
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                type="button"
                disabled={save.isPending}
                onClick={() => {
                  setProblemsRevealed(true)
                  setError(null)
                  if (
                    !isRuleFormValid(form, preserve, new Set(sequences.map((s) => s.id))) ||
                    save.isPending
                  ) {
                    return
                  }
                  save.mutate()
                }}
              >
                {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {isExisting
                  ? t('system.notificationRules.saveChanges', 'Save changes')
                  : t('system.notificationRules.createRule', 'Create rule')}
              </Button>
            </div>
          </div>
        }
      >
        <TabsContent value="rule" className="space-y-4">
          {/* Name + enabled */}
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <label className="block text-[11px] font-medium text-foreground mb-1">
                {t('system.notificationRules.name', 'Name')}
              </label>
              <Input
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder={t(
                  'system.notificationRules.eGFrontDoorPackage',
                  'e.g. Front door package',
                )}
              />
            </div>
            <label className="flex items-center gap-2 pb-1.5 text-[11px] font-medium text-foreground">
              <Switch
                checked={form.enabled}
                onCheckedChange={(next) => patch({ enabled: next })}
                aria-label={t('system.notificationRules.enabled', 'Enabled')}
              />
              {t('system.notificationRules.enabled', 'Enabled')}
            </label>
          </div>

          {/* Trigger */}
          <div>
            <label className="block text-[11px] font-medium text-foreground mb-1">
              {t('system.notificationRules.trigger', 'Trigger')}
            </label>
            <Select
              value={deliveryChoice}
              onChange={(e) => {
                const next = parseDeliveryChoice(e.target.value)
                // Switching to system-event seeds a family (D637) — a
                // system rule with no kinds would be `mixed`. Leaving
                // `immediate` forgets the grouping window.
                if (next) setForm((prev) => applyDeliveryChoice(prev, next))
              }}
              options={deliveryChoices.map((o) => ({ value: o.value, label: o.label }))}
            />
            {deliveryHint && (
              <p className="text-[10px] text-foreground-subtle mt-1">{deliveryHint}</p>
            )}
            {/* The seconds of a grouped rule (D692): 5..60, pre-filled with the
                    default the moment the choice is made. The floor is the
                    operator's own decision 1 — subjects arriving together share
                    one message — and says so under the box. */}
            {groupedSelected && (
              <div className="mt-2">
                <label className="block text-[11px] font-medium text-foreground mb-1">
                  {t('notificationRules.grouping.seconds', 'Group for (seconds)')}
                </label>
                <Input
                  type="number"
                  min={NC_GROUPING_MIN_SEC}
                  max={NC_GROUPING_MAX_SEC}
                  step={1}
                  value={groupingSecN}
                  data-testid="rule-grouping-sec"
                  onChange={(e) => {
                    const next = parseGroupingSec(e.target.value)
                    if (next !== undefined) patch({ groupingSec: next })
                  }}
                />
                <p className="text-[10px] text-foreground-subtle mt-1">
                  {t(
                    'notificationRules.grouping.minNote',
                    'At least 5 s: subjects arriving together share one message.',
                  )}
                </p>
                {ruleAwaitsRecognition && (
                  <p className="text-[10px] text-foreground-subtle mt-1">
                    {t('notificationRules.grouping.scopedHint', {
                      n: groupingSecN,
                      defaultValue: 'A subject not recognised within {{n}} s is not notified.',
                    }).replaceAll('{{n}}', groupingSecN)}
                  </p>
                )}
              </div>
            )}
            {/* Plain Immediate with a name scope fires only on an event written
                    after recognition (D692 §3.7): said here, not discovered. */}
            {deliveryChoice === 'immediate' && ruleAwaitsRecognition && (
              <p className="text-[10px] text-foreground-subtle mt-1">
                {t(
                  'notificationRules.grouping.plainRecognitionHint',
                  'Fires only if the name is already known when an event is written — choose Immediate, grouped to wait for it.',
                )}
              </p>
            )}
          </div>

          {/* Only a NEW rule picks its family (a duplicate, id '', is new):
                  a saved rule's family is fixed (D637). */}
          {!isExisting && systemFamily !== undefined && (
            <SystemFamilySelect
              family={systemFamily}
              onChange={(next) => setForm((prev) => changeSystemEventFamily(prev, next))}
            />
          )}

          {/* Targets — shared NotificationTargetsField (ui-library) */}
          <NotificationTargetsField
            label={t('system.notificationRules.deliveryTargets', 'Delivery targets')}
            targets={targets}
            value={form.targetIds}
            onChange={(next) => setForm((prev) => ({ ...prev, targetIds: next }))}
            emptyMessage={t(
              'system.notificationRules.noDeliveryTargetsConfiguredAdd',
              'No delivery targets configured. Add one under the Targets tab first.',
            )}
            testIdPrefix="rule-target"
          />

          {/* Users — fan out to each user's OWN targets at fire time */}
          <OptionSelect
            mode="multi"
            options={userOptions}
            value={form.targetUsers}
            onChange={(next) => patch({ targetUsers: next })}
            searchable
            creatable={false}
            label={t('system.notificationRules.notifyUsers', 'Notify users')}
            description={t(
              'system.notificationRules.deliversToTheTargetsEach',
              'Delivers to the targets each user owns, only for cameras that user can access.',
            )}
            emptyMessage={t('system.notificationRules.noUsersToNotify', 'No users to notify.')}
            placeholder={t('system.notificationRules.searchUsers', 'Search users…')}
            testId="rule-notify-users"
            optionTestIdPrefix="rule-user"
            listboxId="rule-notify-users-listbox"
          />
        </TabsContent>

        <TabsContent value="devices" className="space-y-4">
          {/* Narrowed to what this KIND can actually use (operator
                  ruling, 2026-10-01): a detection rule no longer offers a
                  door lock; a sensor rule offers its eventful devices AND
                  the cameras (a camera-scoped sensor rule is legitimate,
                  D630 §6). `scopedDevicesLoading` is a
                  distinct state from "answered, none compatible" (D315) —
                  the picker still shows every device while it waits, never
                  "no devices". A device already selected is NEVER dropped
                  from the list by this narrowing (D49). */}
          {scopedDevicesLoading && (
            <p
              className="text-[10px] text-foreground-subtle"
              data-testid="rule-devices-compat-loading"
            >
              {t(
                'notificationRules.devices.compatLoading',
                "Checking which devices this rule's kind can use…",
              )}
            </p>
          )}
          {scopedDevicesFailed && (
            <p
              className="text-[10px] text-foreground-subtle"
              data-testid="rule-devices-compat-failed"
            >
              {t(
                'notificationRules.devices.compatFailed',
                "Couldn't check which devices this rule's kind can use — every device is listed. The hub still refuses an incompatible one on save.",
              )}
            </p>
          )}
          <NotificationRuleDeviceScope
            devices={scopedDevices}
            scope={form.deviceScope}
            onChange={(next) => patch({ deviceScope: next })}
            listState={fleet.state}
            savedScope={opened.deviceScope}
            exceptOffered={ruleScopeExceptOffered(catalog, 'devicesExclude', form)}
          />
        </TabsContent>

        <TabsContent value="actions" className="space-y-4">
          <NotificationRuleActions
            value={form.actions}
            onChange={(next) => patch({ actions: next })}
            devices={actuatable}
            devicesState={fleet.state}
            sequences={sequences}
            onCreateSequence={onCreateSequence}
            showProblems={problemsRevealed}
          />
        </TabsContent>

        <TabsContent value="advanced" className="space-y-4">
          {/* Detection source + zone-crossing direction (moved here
                  2026-10-01, operator ruling): D690 had drawn them as a
                  SECOND "Advanced" group inside the Conditions tab — one
                  operator-visible Advanced surface per rule, not two. */}
          <RuleConditionsAdvancedFields
            catalog={catalog}
            delivery={form.delivery}
            conditions={form.conditions}
            onConditionsChange={(next) => patch({ conditions: next })}
          />

          {/* Cooldown — the minimum gap between two deliveries of this rule.
                A FREE number of seconds, not a menu: the seven-entry select
                this replaces had nothing shorter than 30 s, so 5 / 10 / 15 —
                the intervals the operator actually wanted — could only be
                authored through the API. The hub always took 0..86400. */}
          <div>
            <label className="block text-[11px] font-medium text-foreground mb-1">
              {t('system.notificationRules.cooldownSeconds', 'Cooldown (seconds)')}
            </label>
            <Input
              type="number"
              min={0}
              max={NC_COOLDOWN_MAX_SEC}
              step={1}
              value={String(form.cooldownSec)}
              data-testid="rule-cooldown"
              onChange={(e) => {
                const next = parseCooldown(e.target.value)
                if (next !== undefined) patch({ cooldownSec: next })
              }}
            />
            <p className="text-[10px] text-foreground-subtle mt-1">
              {systemRule
                ? t(
                    'system.notificationRules.aCameraThatFlapsOr',
                    'A camera that flaps, or a node that reconnects every minute, would otherwise send one notification per flap. The cooldown is the shortest gap between two deliveries of this rule.',
                  )
                : t(
                    'system.notificationRules.theShortestGapBetweenTwo',
                    'The shortest gap between two deliveries of this rule, counted as chosen below.',
                  )}{' '}
              {t('system.notificationRules.cooldownRange', { max: String(NC_COOLDOWN_MAX_SEC) })}
            </p>
          </div>

          {/* WHAT the cooldown counts (D654). Both were in the schema for
                  months and authorable only from the viewer or the API, so the
                  operator could not see why a dog after a cat stayed silent. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-foreground mb-1">
                {t('system.notificationRules.cooldownCounted', 'Cooldown counted')}
              </label>
              <Select
                value={form.cooldownScope}
                onChange={(e) => {
                  const next = parseCooldownScope(e.target.value)
                  if (next !== undefined) patch({ cooldownScope: next })
                }}
                options={NC_COOLDOWN_SCOPE_OPTIONS.map((o) => ({
                  value: o.value,
                  label: o.label,
                }))}
                data-testid="rule-cooldown-scope"
              />
              <p className="text-[10px] text-foreground-subtle mt-1">
                {t(
                  'system.notificationRules.perDeviceADeliveryAbout',
                  'Per device: a delivery about one camera (or node) does not hold back another. Whole rule: one delivery per cooldown, whichever device matched.',
                )}
              </p>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-foreground mb-1">
                {t('system.notificationRules.acrossObjectClasses', 'Across object classes')}
              </label>
              <Select
                value={form.cooldownGranularity ?? 'per-class'}
                onChange={(e) =>
                  patch({ cooldownGranularity: parseCooldownGranularity(e.target.value) })
                }
                options={NC_COOLDOWN_GRANULARITY_OPTIONS.map((o) => ({
                  value: o.value,
                  label: o.label,
                }))}
                data-testid="rule-cooldown-granularity"
              />
              <p className="text-[10px] text-foreground-subtle mt-1">
                {t(
                  'system.notificationRules.separateDefaultADogAfter',
                  'Separate (default): a dog after a cat is delivered at once, a second cat still waits. Shared: a cat holds back the next dog for the cooldown. Sounds always count per class.',
                )}
              </p>
            </div>
          </div>

          {/* Snooze — the one setting on a rule that can silence OTHER people */}
          <div>
            <label className="flex items-center gap-2 text-[11px] font-medium text-foreground">
              <Switch
                checked={form.snoozeAllowGlobal}
                onCheckedChange={(next) => patch({ snoozeAllowGlobal: next })}
                aria-label={t('system.notificationRules.allowGlobalSnooze', 'allow global snooze')}
                disabled={snoozeExempt}
              />
              {t(
                'system.notificationRules.anyoneMaySnoozeThisRule',
                'Anyone may snooze this rule for everyone',
              )}
            </label>
            <p className="text-[10px] text-foreground-subtle mt-1">
              {t(
                'system.notificationRules.aSnoozeIsPersonalBy',
                'A snooze is personal by default — it silences only the person who set it. Turn this on for a rule where silencing the whole household is legitimate (the gardener is here all afternoon). Admins can always do it.',
              )}
            </p>
          </div>

          {/* Ask for a verdict on a detection: only a rule that reports
                  a track has one to ask about. */}
          {verdictApplies(form) && (
            <div>
              <label className="flex items-center gap-2 text-[11px] font-medium text-foreground">
                <Switch
                  checked={form.askVerdict === true}
                  onCheckedChange={(next) => patch({ askVerdict: next })}
                  aria-label={t(
                    'system.notificationRules.askVerdictAria',
                    'ask me to confirm detections',
                  )}
                  data-testid="rule-ask-verdict"
                />
                {t('system.notificationRules.askVerdict', 'Ask me to confirm detections')}
              </label>
              <p className="text-[10px] text-foreground-subtle mt-1">
                {t(
                  'system.notificationRules.askVerdictHint',
                  'The notification carries Correct and Wrong. A tap marks the detection for retraining, the same mark as in the Library, and records who was asked and when. Channels with no buttons (email, Pushover, Gotify, WhatsApp, Discord) get the same two choices as links.',
                )}
              </p>
            </div>
          )}

          {/* The durations THIS rule's notification offers as buttons. A rule
                  no window can silence (it concerns or arms the alarm, D133)
                  has none to choose — nothing is drawn, and no sentence stands
                  in for it (R3). */}
          {!snoozeExempt && (
            <div>
              <label className="block text-[11px] font-medium text-foreground mb-1">
                {t('system.notificationRules.snoozeButtons', 'Snooze buttons')}
              </label>
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  {NC_SNOOZE_BUTTON_CHOICES.map((minutes) => {
                    const chosen = form.snoozeOptions ?? NC_DEFAULT_SNOOZE_MINUTES
                    const on = chosen.includes(minutes)
                    return (
                      <Button
                        key={minutes}
                        type="button"
                        size="sm"
                        variant={on ? 'primary' : 'outline'}
                        onClick={() =>
                          patch({
                            snoozeOptions: on
                              ? chosen.filter((m) => m !== minutes)
                              : [...chosen, minutes].toSorted((a, b) => a - b),
                          })
                        }
                      >
                        {snoozeChoiceLabel(minutes)}
                      </Button>
                    )
                  })}
                </div>
                <p className="text-[10px] text-foreground-subtle mt-1">
                  {form.snoozeOptions === undefined
                    ? t(
                        'system.notificationRules.notSetTheNotificationOffers',
                        'Not set — the notification offers the defaults ({{value1}}). A pause opened from a button silences this camera for this class of subject, only for whoever received the notification, and sends no summary.',
                        { value1: NC_DEFAULT_SNOOZE_MINUTES.map(snoozeChoiceLabel).join(', ') },
                      )
                    : form.snoozeOptions.length === 0
                      ? t(
                          'system.notificationRules.noSnoozeButtonsOnThis',
                          'No snooze buttons on this rule. That is an explicit choice: the notification cannot be silenced from the lock screen.',
                        )
                      : t(
                          'system.notificationRules.fourAtMostEverySnooze',
                          'Four at most. Every snooze button takes space from the rule’s action buttons — ntfy accepts three in total.',
                        )}
                </p>
                {form.snoozeOptions !== undefined && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="mt-1"
                    onClick={() => patch({ snoozeOptions: undefined })}
                  >
                    {t('system.notificationRules.backToTheDefaults', 'Back to the defaults')}
                  </Button>
                )}
              </>
            </div>
          )}

          {/* THE ACTUAL SNOOZE. The palette above chooses which durations
                  this rule's NOTIFICATION will offer; it silences nothing, and
                  on 2026-08-14 an operator pressed it expecting exactly that
                  and nothing reached the server — because this page had no
                  create-snooze call site at all. Only for a SAVED rule: a
                  window needs a rule id to be scoped to. */}
          {isExisting && rule && !snoozeExempt && (
            <div>
              <label className="block text-[11px] font-medium text-foreground mb-1">
                {t('system.notificationRules.silenceItNow', 'Silence it now')}
              </label>
              <NotificationRuleSnoozeControl
                ruleId={rule.id}
                ruleName={rule.name}
                exempt={snoozeExempt}
                variant="full"
              />
            </div>
          )}
        </TabsContent>

        <TabsContent value="notification" className="space-y-4">
          {/* Priority + media */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-foreground mb-1">
                {t('system.notificationRules.priority', 'Priority')}
              </label>
              <Select
                value={String(form.priority)}
                onChange={(e) => patch({ priority: Number(e.target.value) })}
                options={NC_PRIORITY_OPTIONS.map((o) => ({
                  value: String(o.value),
                  label: o.label,
                }))}
              />
            </div>
            {/* A subject that owns NO FRAME has no media controls, because
                  every one of them would be a knob that does nothing: the
                  attachment ladder resolves media by owner, and a system event
                  freezes none. Stated, not merely hidden — `buildRuleInput`
                  writes `attach: 'none'` for that kind and the operator has to
                  know why the section they remember is gone.

                  A SOUND rule was here until D165. It owns no frame either, but
                  it now photographs the camera at the match, so it gets the
                  controls plus one line saying what its picture IS. */}
            {!kindSpec.carriesMedia && (
              <div
                className="rounded-md border border-border px-3 py-2 text-[11px] text-foreground-subtle"
                data-testid="rule-media-none"
              >
                {kindSpec.mediaBlurb ??
                  t(
                    'system.notificationRules.aSystemEventCarriesNo',
                    'A system event carries no image: there is no camera frame behind "a node went offline". This rule sends text only.',
                  )}
              </div>
            )}
            {kindSpec.carriesMedia && kindSpec.mediaBlurb !== undefined && (
              <div className="rounded-md border border-border px-3 py-2 text-[11px] text-foreground-subtle">
                {kindSpec.mediaBlurb}
              </div>
            )}
            {/* ONE picture selector for every kind that carries media — a
                  sensor included (D897): the picture is rendered at send time
                  from the clean frame of the moment, so the rule says only
                  what it wants to SEE. The modes offered are the kind's own
                  (`imageModesForKind`: a sound is never offered a crop). */}
            {kindSpec.carriesMedia && (
              <div>
                <label className="block text-[11px] font-medium text-foreground mb-1">
                  {t('system.notificationRules.notificationImage', 'Image')}
                </label>
                <Select
                  value={form.mediaImage}
                  onChange={(e) => {
                    const next = parseMediaImage(e.target.value)
                    if (next) patch({ mediaImage: next })
                  }}
                  options={imageOptions.map((o) => ({ value: o.value, label: o.label }))}
                  data-testid="rule-media-image"
                />
                <p className="mt-1 text-[10px] text-foreground-subtle">
                  {imageOptions.find((o) => o.value === form.mediaImage)?.description}
                </p>
                <div className="mt-2 space-y-1">
                  {/* Only on a rule whose trigger IS a zone, and only on a
                        scene: a crop never shows it, and the hub refuses the
                        flag anywhere else. */}
                  {zoneTrigger && form.mediaImage !== 'crop' && form.mediaImage !== 'none' && (
                    <label className="flex items-start gap-2 text-xs text-foreground cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.mediaShowTriggerZone}
                        onChange={(e) => patch({ mediaShowTriggerZone: e.target.checked })}
                        className="accent-primary mt-0.5"
                        data-testid="rule-media-show-trigger-zone"
                      />
                      <span>
                        {t(
                          'system.notificationRules.showTriggerZone',
                          'Draw the zone that triggered the rule',
                        )}
                        <span className="block text-[10px] text-foreground-subtle">
                          {t(
                            'system.notificationRules.showTriggerZoneHelp',
                            'Outlines the zone on the scene. Not drawn on a subject crop.',
                          )}
                        </span>
                      </span>
                    </label>
                  )}
                  {/* D903: the subject's path — on every picture, a crop
                        included (mapped into it), for a kind whose subject is
                        a tracked object; the hub refuses it anywhere else. */}
                  {subjectHasPath(kind) && form.mediaImage !== 'none' && (
                    <label className="flex items-start gap-2 text-xs text-foreground cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.mediaShowSubjectPath}
                        onChange={(e) => patch({ mediaShowSubjectPath: e.target.checked })}
                        className="accent-primary mt-0.5"
                        data-testid="rule-media-show-subject-path"
                      />
                      <span>
                        {t('system.notificationRules.showSubjectPath', "Show the subject's path")}
                        <span className="block text-[10px] text-foreground-subtle">
                          {t(
                            'system.notificationRules.showSubjectPathHelp',
                            'Draws the line the subject walked, up to the moment of the picture. On a crop, only the part inside it.',
                          )}
                        </span>
                      </span>
                    </label>
                  )}
                  <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.mediaGif}
                      onChange={(e) => patch({ mediaGif: e.target.checked })}
                      className="accent-primary"
                    />
                    {t(
                      'system.notificationRules.attachAGifAroundThe',
                      'Attach a GIF around the event',
                    )}
                  </label>
                  <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.mediaClip}
                      onChange={(e) => patch({ mediaClip: e.target.checked })}
                      className="accent-primary"
                    />
                    {t(
                      'system.notificationRules.attachAnMp4ClipAround',
                      'Attach an MP4 clip around the event',
                    )}
                  </label>
                </div>
                {(form.mediaGif || form.mediaClip) && (
                  <div className="mt-2">
                    <label className="block text-[11px] font-medium text-foreground mb-1">
                      {t('system.notificationRules.videoQuality', 'Video quality')}
                    </label>
                    <Select
                      value={form.mediaProfile ?? ''}
                      onChange={(e) => patch({ mediaProfile: parseClipProfile(e.target.value) })}
                      options={NC_CLIP_PROFILE_OPTIONS.map((o) => ({
                        value: o.value,
                        label: o.label,
                      }))}
                    />
                    <p className="mt-1 text-[10px] text-foreground-subtle">
                      {t(
                        'system.notificationRules.aNotificationIsWatchedOn',
                        'A notification is watched on a phone — the cheapest stream is normally the right one, and the high profile only costs CPU to render.',
                      )}
                    </p>
                    <label className="mt-2 block text-[11px] font-medium text-foreground mb-1">
                      {t('system.notificationRules.playbackSpeed', 'Playback speed')}
                    </label>
                    <Select
                      value={form.mediaClipSpeed === undefined ? '' : String(form.mediaClipSpeed)}
                      onChange={(e) => patch({ mediaClipSpeed: parseClipSpeed(e.target.value) })}
                      options={NC_CLIP_SPEED_OPTIONS.map((o) => ({
                        value: o.value,
                        label: o.label,
                      }))}
                    />
                    <p className="mt-1 text-[10px] text-foreground-subtle">
                      {t(
                        'system.notificationRules.aNotificationClipIsGlanced',
                        'A notification clip is glanced at, not watched: at 2× the recipient sees the whole passage in half the time and the file is half the size. Real time is there when the detail matters more than the glance.',
                      )}
                    </p>
                  </div>
                )}
              </div>
            )}
            {/* Sensor rules only (ADR 0632): a sensor linked to several
                  cameras photographs all of them at the trigger. Hidden when
                  the rule ships no image — the save drops the choice then. */}
            {kind === 'sensor' && kindSpec.carriesMedia && form.mediaImage !== 'none' && (
              <div>
                <label className="block text-[11px] font-medium text-foreground mb-1">
                  {t('system.notificationRules.linkedCameras', 'Linked cameras')}
                </label>
                <Select
                  value={form.mediaLinkedCameras ?? ''}
                  onChange={(e) =>
                    patch({ mediaLinkedCameras: parseLinkedCameras(e.target.value) })
                  }
                  options={NC_LINKED_CAMERA_OPTIONS.map((o) => ({
                    value: o.value,
                    label: o.label,
                  }))}
                  data-testid="rule-media-linked-cameras"
                />
                <p className="mt-1 text-[10px] text-foreground-subtle">
                  {t(
                    'system.notificationRules.whenTheSensorIsLinked',
                    'When the sensor is linked to several cameras, all of them are photographed the moment it fires. Cameras that are offline or asleep are left out.',
                  )}
                </p>
              </div>
            )}
          </div>

          {/* Template */}
          <div className="space-y-2">
            <TemplateField
              label={t('system.notificationRules.notificationTitle', 'Notification title')}
              value={form.templateTitle}
              onChange={(next) => patch({ templateTitle: next })}
              vars={varsFor('title')}
              testId="rule-template-title"
            />
            <TemplateField
              label={t('system.notificationRules.notificationBody', 'Notification body')}
              value={form.templateBody}
              onChange={(next) => patch({ templateBody: next })}
              vars={varsFor('body')}
              multiline
              testId="rule-template-body"
            />
            <p className="text-[10px] text-foreground-subtle">
              {t(
                'system.notificationRules.leaveBothBlankForThe',
                "Leave both blank for the hub's own wording (editable on the Texts tab).",
              )}
            </p>
            {summaryTemplateWarning(form) !== null && (
              <p className="text-[10px] text-warning" data-testid="rule-template-summary-warning">
                {summaryTemplateWarning(form)}
              </p>
            )}
            <TemplatePreview
              context={ruleTemplateContext('body')}
              title={form.templateTitle}
              body={form.templateBody}
              testId="rule-template-preview"
            />
          </div>
        </TabsContent>

        <TabsContent value="conditions" className="space-y-4">
          {/* Catalog-driven conditions editor (D2). */}
          <div className="rounded-md border border-border px-3 py-3">
            <div className="mb-2 text-[11px] font-semibold text-foreground">
              {systemRule
                ? t('system.notificationRules.whichSystemEvents', 'Which system events')
                : (conditionTabLabel(form.conditions) ??
                  t('system.notificationRules.conditions', 'Conditions'))}
            </div>
            {form.conditions.audio !== undefined && (
              <p className="mb-2 text-[10px] text-foreground-subtle">
                {t(
                  'system.notificationRules.thisIsASoundRule',
                  'This is a SOUND rule: it fires on a confirmed sampling window of audio, never on a picture. Name the sounds and/or keep a level threshold — with neither it can never match. Everything else below still composes (a camera scope, a schedule).',
                )}
              </p>
            )}
            {form.conditions.occupancy !== undefined && (
              <p className="mb-2 text-[10px] text-foreground-subtle">
                {t(
                  'system.notificationRules.thisIsAnOccupancyRule',
                  "This is an OCCUPANCY rule: it fires when the count in a camera frame or a zone crosses your threshold and holds. Pick the camera on the Devices tab first — the zone list is that camera's.",
                )}
              </p>
            )}
            {systemRule && (
              <p className="mb-2 text-[10px] text-foreground-subtle">
                {t(
                  'system.notificationRules.pickTheEventsThisRule',
                  'Pick the events this rule reacts to, then narrow them if you want. Nothing else on a system rule is a condition — there is no detection behind it.',
                )}
              </p>
            )}
            {catalog.length === 0 ? (
              <p className="text-[10px] text-foreground-subtle">
                {t(
                  'system.notificationRules.conditionCatalogUnavailableThisRule',
                  'Condition catalog unavailable — this rule matches on its trigger and targets alone.',
                )}
              </p>
            ) : (
              <RuleConditionsEditor
                // A SUMMARY rule is sent on its summary schedule (D647): the
                // active-hours schedule is not one of its controls.
                catalog={
                  isStateSummaryForm(form)
                    ? catalog.filter((descriptor) => descriptor.id !== 'schedule')
                    : catalog
                }
                taxonomy={taxonomy}
                delivery={form.delivery}
                conditions={form.conditions}
                classScope={form.classScope}
                onClassScopeChange={(next) => patch({ classScope: next })}
                actions={formToActions(form.actions)}
                sequenceActionsOf={(id) => sequences.find((s) => s.id === id)?.actions}
                savedConditions={opened.conditions}
                schedule={form.schedule}
                deviceIds={formScopedDeviceIds(form)}
                zoneCameraIds={zoneCameraIds(form.deviceScope, cameras)}
                cameras={cameras}
                fleet={fleet}
                allDevices={actuatable}
                gateable={gateable}
                gateableScenes={gateableScenes}
                onConditionsChange={(next) => patch({ conditions: next })}
                onScheduleChange={(next) => patch({ schedule: next })}
                summary={isStateSummaryForm(form)}
              />
            )}
          </div>

          {systemRule && (
            <SystemEventDeliveryField
              value={form.systemEventDelivery}
              family={systemFamily}
              onChange={(next) => patch({ systemEventDelivery: next })}
              draft={() => buildRuleInput(form, preserve, catalog)}
            />
          )}

          {/* FIRE IT NOW. Distinct from the dry-run below in the one way
                that matters: this DELIVERS. It plans the event server-side from
                the rule's own conditions (`nc.testRule`), bypasses the cooldown
                and the mute, never runs the actions, and the notification
                arrives on the phone marked [TEST]. Only for a SAVED rule —
                there is no id to test otherwise, and testing the unsaved form
                is what the dry-run is for. */}
          {isExisting && rule && (
            <div className="rounded-md border border-border px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold text-foreground">
                  {t('system.notificationRules.testThisRuleForReal', 'Test this rule for real')}
                </div>
                <NotificationRuleTestButton
                  ruleId={rule.id}
                  ruleName={rule.name}
                  variant="full"
                  showResult
                  {...(formScopedDeviceIds(form)[0] !== undefined
                    ? { fallbackDeviceId: formScopedDeviceIds(form)[0] }
                    : {})}
                />
              </div>
              <p className="mt-1 text-[10px] text-foreground-subtle">
                {t(
                  'system.notificationRules.buildsTheEventThisRule',
                  "Builds the event this rule is about, runs the REAL evaluation and delivery, and sends the notification to every target — marked [TEST] in the body. The cooldown and the camera mute are bypassed (neither window is consumed); the rule's actions are never run. Saved conditions only: save first to test an edit.",
                )}
              </p>
            </div>
          )}

          {/* Dry-run panel (D2). Hidden for a system rule: `testRule`
                evaluates PERSISTED detection records, and there is no such
                record behind "a node went offline" — the panel would answer
                "nothing matched" for a rule that is working perfectly. */}
          {!systemRule && (
            <div className="rounded-md border border-border px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold text-foreground">
                  {t('system.notificationRules.testRule', 'Test rule')}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  disabled={
                    testRun.isPending ||
                    !isRuleFormValid(form, preserve, new Set(sequences.map((s) => s.id)))
                  }
                  onClick={() => {
                    setError(null)
                    testRun.mutate()
                  }}
                >
                  {testRun.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FlaskConical className="h-3.5 w-3.5" />
                  )}
                  {t('system.notificationRules.dryRunLast60Min', 'Dry-run (last 60 min)')}
                </Button>
              </div>
              <p className="mt-1 text-[10px] text-foreground-subtle">
                {t(
                  'system.notificationRules.evaluateTheCurrentUnsavedRule',
                  'Evaluate the CURRENT (unsaved) rule against recently persisted records — no notification is sent.',
                )}
              </p>
              {testResults !== null && (
                <TestRunResults
                  delivery={form.delivery}
                  results={testResults}
                  targetNames={targetNames}
                />
              )}
            </div>
          )}
        </TabsContent>
      </ItemFormDialog>
    </Tabs>
  )
}

interface UnsupportedTriggerDialogProps {
  readonly rule: NcRule | null
  readonly onCancel: () => void
}

/**
 * The read-only view of a rule this build cannot author.
 *
 * Deliberately contains NO control that writes: no trigger select, no save.
 * The rule is shown as stored (trigger, targets, condition keys) so the
 * operator can see it is intact and manage it from a surface that does know
 * the trigger — the viewer, or an updated admin UI. Deleting and toggling stay
 * available from the LIST row, which does not need to understand the trigger.
 */
function UnsupportedTriggerDialog({ rule, onCancel }: UnsupportedTriggerDialogProps) {
  const { t } = useTranslation()
  const conditionKeys = Object.keys(rule?.conditions ?? {})
  return (
    <ItemFormDialog
      open
      onClose={onCancel}
      title={rule?.name ?? t('system.notificationRules.rule', 'Rule')}
      icon={BellRing}
      width="lg"
    >
      <Badge variant="warning" className="mb-3">
        read-only
      </Badge>
      <div
        className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        data-testid="unsupported-trigger-notice"
      >
        <Trans
          i18nKey="system.notificationRules.unsupportedTrigger"
          values={{ trigger: rule?.delivery }}
          components={{ code: <code /> }}
        />
      </div>
      <dl className="mt-3 space-y-1.5 text-[11px]">
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-foreground-subtle">
            {t('system.notificationRules.trigger', 'Trigger')}
          </dt>
          <dd className="text-foreground">{rule?.delivery}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-foreground-subtle">
            {t('system.notificationRules.enabled', 'Enabled')}
          </dt>
          <dd className="text-foreground">{rule?.enabled ? t('common.yes') : t('common.no')}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-foreground-subtle">
            {t('system.notificationRules.targets', 'Targets')}
          </dt>
          <dd className="text-foreground">{rule?.targets.length ?? 0}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-foreground-subtle">
            {t('system.notificationRules.conditions', 'Conditions')}
          </dt>
          <dd className="text-foreground">
            {conditionKeys.length > 0 ? conditionKeys.join(', ') : t('common.none')}
          </dd>
        </div>
      </dl>
    </ItemFormDialog>
  )
}

interface TestRunResultsProps {
  readonly delivery: NcRule['delivery']
  readonly results: readonly NcTestResult[]
  readonly targetNames: readonly string[]
}

/** Renders the testRule dry-run: matched/failed rows + the empty / device-event notes. */
function TestRunResults({ delivery, results, targetNames }: TestRunResultsProps) {
  const { t } = useTranslation()
  if (delivery === 'device-event') {
    return (
      <p className="mt-2 text-[11px] text-foreground-subtle">
        {t(
          'system.notificationRules.deviceEventRulesCannotBe',
          'Device-event rules cannot be dry-run: the sensor-event store has no cross-device scan surface, so a test returns no candidate records. The rule still fires live on a matching doorbell press / sensor change.',
        )}
      </p>
    )
  }
  if (results.length === 0) {
    return (
      <p className="mt-2 text-[11px] text-foreground-subtle">
        {t(
          'system.notificationRules.noRecordsInTheLast',
          'No records in the last 60 minutes matched — nothing to evaluate.',
        )}
      </p>
    )
  }
  const firing = results.filter((r) => r.wouldFire).length
  return (
    <div className="mt-2 space-y-1.5">
      <div className="text-[11px] text-foreground-subtle">
        {t('system.notificationRules.wouldFire', { firing, count: results.length })}
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {results.slice(0, 50).map((r) => (
          <li key={r.recordId} className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]">
            {r.wouldFire ? (
              <CheckCircle className="h-3.5 w-3.5 shrink-0 text-success" />
            ) : (
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
            )}
            <span className="w-32 shrink-0 text-foreground-subtle">
              {new Date(r.timestamp).toLocaleString()}
            </span>
            <span className="w-14 shrink-0 text-foreground-subtle">#{r.deviceId}</span>
            <span className="min-w-0 flex-1 truncate text-foreground">
              {r.label ?? r.className ?? t('system.notificationRules.objectFallback')}
            </span>
            {r.wouldFire ? (
              <span className="shrink-0 truncate text-success">
                → {targetNames.join(', ') || t('system.notificationRules.targetsFallback')}
              </span>
            ) : (
              r.failedCondition && (
                <span className="shrink-0 text-foreground-subtle">failed: {r.failedCondition}</span>
              )
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default NotificationRulesPage
