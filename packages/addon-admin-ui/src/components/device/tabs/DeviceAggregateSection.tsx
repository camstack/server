import type { FieldProbeResult } from '@camstack/types'
import { makeSourceBrokerId } from '@camstack/types'
import {
  useDeviceManagerGetDevice,
  useDeviceManagerGetDeviceAggregate,
  useDeviceManagerRunDeviceAction,
  useDeviceManagerTestCreationField,
  useDeviceManagerUpdateDeviceFieldsBatch,
  useStreamBrokerProbeStream,
  useStreamBrokerRegenerateRtspToken,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAuth } from '../../../contexts/auth-context'
import { useFormSaveController } from '../../../hooks/useFormSaveController'
import type {
  ConfigFieldBase,
  ConfigFieldWithValue,
  ConfigSectionWithValues,
  ConfigUISchemaWithValues,
} from '../../../types/config-ui'
import { TabbedSettingsForm, type LeadingSettingsTab } from '../../form-builder/TabbedSettingsForm'
import { useQuickDetailSave } from '../quick-detail-save'
import { isDeviceExportSection } from './device-export-tab'
import { isConfigTabSection } from './config-tab-sections'
import { buildVisibilityContext } from './visibility-context'
import { useTranslation } from 'react-i18next'

// `super_admin` retired with the caps-only auth refactor — `admin` is
// now the top role. Rank levels kept for forward-compat with `minRole`
// declarations on legacy config UI schemas.
function canEditField(isAdmin: boolean, minRole: string | undefined): boolean {
  if (!minRole) return true // default — handled by cap-level auth
  // v2 auth: only two tiers (admin / non-admin). Any `minRole` other than
  // the literal `admin` is treated as "no restriction" — non-admin
  // visibility is controlled by the cap's scope grants, not this field.
  if (minRole === 'admin') return isAdmin
  return true
}

/**
 * DeviceAggregateSection — renders the unified device-details page fed by
 * `deviceManager.getDeviceSettingsAggregate` (slow, cached) merged with
 * `deviceManager.getDeviceLiveInfoAggregate` (fast-poll, readonly).
 *
 * Every editable field carries `writerCapName` + `writerAddonId` — the
 * save path routes batched mutations through
 * `deviceManager.updateDeviceFieldsBatch` so each provider owns its own
 * storage without the frontend having to know about any of them.
 */

interface Changeset {
  readonly writerCapName: string
  readonly writerAddonId: string
  readonly key: string
  readonly value: unknown
}

/**
 * Sort sections by (tab, order) so the tab bar produced downstream
 * groups them deterministically. Used for the settings-only aggregate —
 * live contributions have their own renderer on the Overview tab.
 *
 * Export-tab sections (HAP / Alexa / HA-MQTT) deliberately sort by
 * `section.id` alphabetically instead of `order` so the operator sees a
 * stable layout regardless of which export addon happened to pick which
 * `order` value. Every export addon contributes to the same tab so the
 * comparator only flips for that tab — the rest of the schema keeps its
 * existing (tab, order) ordering.
 */
function orderSections(
  schema: ConfigUISchemaWithValues | null | undefined,
): ConfigUISchemaWithValues | null {
  if (!schema) return null
  const ordered = [...schema.sections].toSorted((a, b) => {
    const tA = a.tab ?? 'general'
    const tB = b.tab ?? 'general'
    if (tA !== tB) return tA.localeCompare(tB)
    if (isDeviceExportSection(a) && isDeviceExportSection(b)) {
      return a.id.localeCompare(b.id)
    }
    return (a.order ?? 0) - (b.order ?? 0)
  })
  const out: ConfigUISchemaWithValues = { sections: ordered }
  return schema.tabs ? { ...out, tabs: schema.tabs } : out
}

/**
 * Structural field variants in `ConfigFieldWithValue` that don't extend
 * `ConfigFieldBase` and have no value/writer metadata. Narrowing the
 * union by `type` lets us access base-typed fields without casts.
 */
type StructuralFieldType =
  | 'separator'
  | 'info'
  | 'button'
  | 'widget'
  | 'addon-action-button'
  | 'device-action-button'
  | 'account-sign-in'
  | 'secret-presence'

function isStructuralField(
  field: ConfigFieldWithValue,
): field is Extract<ConfigFieldWithValue, { type: StructuralFieldType }> {
  return (
    field.type === 'separator' ||
    field.type === 'info' ||
    field.type === 'button' ||
    field.type === 'widget' ||
    field.type === 'addon-action-button' ||
    field.type === 'device-action-button' ||
    field.type === 'account-sign-in' ||
    field.type === 'secret-presence'
  )
}

function fieldKey(field: ConfigFieldWithValue): string | null {
  // Every variant in `ConfigFieldWithValue` carries a `key` (structural
  // fields keep it for React-key purposes). Returning the key directly is
  // safe — no narrowing required.
  return field.key
}

function fieldValue(field: ConfigFieldWithValue): unknown {
  if (isStructuralField(field)) return undefined
  return field.value
}

function fieldMeta(field: ConfigFieldWithValue): ConfigFieldBase | null {
  if (isStructuralField(field)) return null
  return field
}

/**
 * Recursive walker — visits every leaf field reachable from a section,
 * descending into `'group'` (carries `fields`) and `'sub-tabs'` (carries
 * `tabs[].fields`). The hydrated value variants share the same shape as
 * the schema variants so the recursion is type-safe via narrowing.
 */
function walkFields(
  fields: readonly ConfigFieldWithValue[],
  visit: (field: ConfigFieldWithValue) => void,
): void {
  for (const field of fields) {
    visit(field)
    if (field.type === 'group') {
      walkFields(field.fields, visit)
    } else if (field.type === 'sub-tabs') {
      for (const tab of field.tabs) {
        walkFields(tab.fields, visit)
      }
    }
  }
}

function extractValues(schema: ConfigUISchemaWithValues | null): Record<string, unknown> {
  if (!schema) return {}
  const out: Record<string, unknown> = {}
  for (const section of schema.sections) {
    walkFields(section.fields, (field) => {
      const key = fieldKey(field)
      if (key !== null) out[key] = fieldValue(field)
    })
  }
  return out
}

function findWriter(
  schema: ConfigUISchemaWithValues | null,
  targetKey: string,
): { readonly capName: string; readonly addonId: string } | null {
  if (!schema) return null
  let found: { readonly capName: string; readonly addonId: string } | null = null
  for (const section of schema.sections) {
    walkFields(section.fields, (field) => {
      if (found !== null) return
      if (fieldKey(field) !== targetKey) return
      const meta = fieldMeta(field)
      if (meta && meta.writerCapName && meta.writerAddonId) {
        found = { capName: meta.writerCapName, addonId: meta.writerAddonId }
      }
    })
    if (found !== null) break
  }
  return found
}

function forceReadonlyOnSection(section: ConfigSectionWithValues): ConfigSectionWithValues {
  return {
    ...section,
    fields: section.fields.map(forceReadonly),
  }
}

function forceReadonly(field: ConfigFieldWithValue): ConfigFieldWithValue {
  // Structural fields (separator/info/button/object-array) have no
  // editable control and are not `ConfigFieldBase`-derived, so they
  // lack `readonlyField`. They're always "readonly" by nature — return
  // them unchanged.
  if (
    field.type === 'separator' ||
    field.type === 'info' ||
    field.type === 'button' ||
    field.type === 'object-array'
  ) {
    return field
  }
  return { ...field, readonlyField: true }
}

function enforceRoleAcl(
  schema: ConfigUISchemaWithValues | null,
  isAdmin: boolean,
): ConfigUISchemaWithValues | null {
  if (!schema) return schema
  return {
    ...schema,
    sections: schema.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => {
        const meta = fieldMeta(field)
        if (!meta) return field
        return canEditField(isAdmin, meta.minRole) ? field : forceReadonly(field)
      }),
    })),
  }
}

interface DeviceAggregateSectionProps {
  readonly deviceId: number
  /**
   * Optional predicate that filters which contributed sections are
   * rendered. The cluster Device Overrides tab uses this to narrow
   * the aggregate down to the Pipeline editor only; leaving it
   * unset renders the full device-details form as usual.
   */
  readonly sectionFilter?: (section: ConfigSectionWithValues) => boolean
  /**
   * Optional controlled inner-tab id + change handler, threaded straight
   * into `TabbedSettingsForm`. DeviceDetail uses these to mirror the
   * active inner tab into a `?sub=` URL param so a refresh/remount
   * restores it. Unset = legacy internal-state behaviour.
   */
  readonly activeSubTab?: string | null
  readonly onSubTabChange?: (id: string) => void
  /**
   * When true, the rendered form collapses every contributed section into
   * ONE flat list with no inner sub-tab bar.
   */
  readonly flattenSubTabs?: boolean
  /**
   * Optional regrouping of the filtered sections into second-level sub-tabs.
   * The contributed sections all share one `tab` id (e.g. every detection
   * section is `tab: 'detection-pipeline'`), which would render as a single
   * sub-tab; this remaps each section's `tab` to a GROUP id via `groupOf` and
   * supplies the group tab bar via `tabs`, so a long flat list becomes a set
   * of concern-scoped sub-tabs sharing one save controller. Ignored when
   * `flattenSubTabs` is set.
   */
  readonly subTabGrouping?: {
    readonly groupOf: (section: ConfigSectionWithValues) => string
    readonly tabs: ReadonlyArray<{
      readonly id: string
      readonly label: string
      readonly icon: string
    }>
  }
  /**
   * Custom-content tabs placed first in the same bar as the grouped settings
   * tabs (e.g. a step inspector ahead of the settings groups). The form stays
   * mounted while one is active, so unsaved edits keep accumulating.
   */
  readonly leadingTabs?: readonly LeadingSettingsTab[]
}

const EMPTY_SCHEMA: ConfigUISchemaWithValues = { sections: [] }

export function DeviceAggregateSection({
  deviceId,
  sectionFilter,
  activeSubTab,
  onSubTabChange,
  flattenSubTabs,
  subTabGrouping,
  leadingTabs,
}: DeviceAggregateSectionProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const isAdmin = user?.isAdmin === true
  // Ref for editingPaused — set by useFormSaveController, read by the query's refetchInterval.
  // Using a ref avoids circular dependency (query → hook → query).
  const editingPausedRef = useRef(false)

  // Single round-trip for the entire device-details panel. The backend
  // fans out to every `exposesDeviceSettings` provider + the device-
  // manager base section in parallel and returns `{settings, live}` in
  // one response. Previously the UI fired two parallel queries with
  // different polling cadences — duplicated provider enumeration on
  // every tick, and the UI had to stitch them client-side anyway. One
  // query + `keepPreviousData` gives the same polling UX without the
  // split.
  const { data: aggregateData, isLoading: isSettingsLoading } = useDeviceManagerGetDeviceAggregate(
    { deviceId },
    {
      refetchInterval: () => (editingPausedRef.current ? false : 2500),
      enabled: Number.isFinite(deviceId),
    },
  )

  // Lightweight lookup used solely to resolve the probe addonId + type on
  // demand; keeps the aggregate query untouched.
  const { data: deviceMeta } = useDeviceManagerGetDevice(
    { deviceId },
    { enabled: Number.isFinite(deviceId) },
  )
  const settingsData = aggregateData?.settings ?? null
  const liveData = aggregateData?.live ?? null

  // Merge settings + live into one schema. Live sections are forced
  // readonly so the user can't accidentally edit runtime-only fields.
  // `sectionFilter` narrows the aggregate to a subset (e.g. pipeline-
  // only for the cluster Device Overrides tab) without having to
  // re-query the backend — the aggregator returns the full
  // contribution, we render only the slice the caller cares about.
  //
  // When no sectionFilter is supplied (default Config tab path), drop
  // sections marked `location: 'top-tab'` — those live in their own
  // discovered top-level tab in DeviceDetail and would otherwise
  // double-render here. Callers that want to render the top-tab body
  // pass an explicit sectionFilter (e.g.
  // `s.location === 'top-tab' && s.tab === 'zones'`).
  const merged = useMemo((): ConfigUISchemaWithValues | null => {
    if (!settingsData && !liveData) return null
    const settingSections = settingsData?.sections ?? []
    const liveSections = (liveData?.sections ?? []).map(forceReadonlyOnSection)
    const allSections = [...settingSections, ...liveSections]
    // Camera-only addons (motion-wasm, pipeline-orchestrator,
    // pipeline-analytics, snapshot) now gate their settings contribution
    // server-side — `getDeviceSettingsContribution` returns null on
    // non-camera devices. The aggregator therefore receives a clean list
    // already; no client-side allow-list needed.
    // device-export sections (HAP / Alexa / HA-MQTT) are hoisted into a
    // dedicated top-level "Export" tab by `DeviceDetail.tsx`. Drop them
    // from the default (Config) view so they don't double-render —
    // callers that want them pass an explicit `sectionFilter`
    // (`isDeviceExportSection`). The D648 Extensions card is dropped too:
    // the Customize tab carries its slots now (D676 ruling 4).
    const filteredSections = sectionFilter
      ? allSections.filter(sectionFilter)
      : allSections.filter(isConfigTabSection)
    if (filteredSections.length === 0) return null
    // Second-level regrouping: remap each section's `tab` to a GROUP id and
    // supply the group tab bar. The contributed detection sections all share
    // one `tab`, so without this they'd collapse to a single sub-tab; the
    // regroup turns them into concern-scoped sub-tabs under one save
    // controller. An unmapped section falls through to the caller's default
    // group (via `groupOf`) so nothing is dropped.
    if (subTabGrouping) {
      const grouped = filteredSections.map((s) => ({ ...s, tab: subTabGrouping.groupOf(s) }))
      const referenced = new Set(grouped.map((s) => s.tab))
      const groupTabs = subTabGrouping.tabs.filter((t) => referenced.has(t.id))
      return groupTabs.length > 0 ? { tabs: groupTabs, sections: grouped } : { sections: grouped }
    }
    // Tab declarations must follow the filtered sections — otherwise a
    // top-tab body inherits every other addon's tab from the raw
    // aggregate (renders an inner tab bar with the full bouquet) and a
    // location-filtered Config tab keeps a "Zones" tab that points at
    // zero sections (empty inner tab). Restrict the declarations to the
    // tab ids actually referenced by what the caller asked for.
    const referencedTabIds = new Set<string>()
    for (const s of filteredSections) referencedTabIds.add(s.tab ?? 'general')
    const allTabDecls = [
      ...(settingsData?.tabs ?? []),
      ...(liveData?.tabs ?? []).filter(
        (lt) => !(settingsData?.tabs ?? []).some((st) => st.id === lt.id),
      ),
    ]
    const tabs = allTabDecls.filter((t) => referencedTabIds.has(t.id))
    return tabs.length > 0 ? { tabs, sections: filteredSections } : { sections: filteredSections }
  }, [settingsData, liveData, sectionFilter, subTabGrouping])

  // The whole aggregate's values, for `showWhen` only: a field of one tab may be
  // gated on a key owned by another (analyzer knobs in Config -> Motion read
  // `motionSources` from Detection pipeline). See `visibility-context.ts`.
  const visibilityContext = useMemo(
    () =>
      buildVisibilityContext([...(settingsData?.sections ?? []), ...(liveData?.sections ?? [])]),
    [settingsData, liveData],
  )
  const ordered = useMemo(() => orderSections(merged), [merged])
  const enforced = useMemo(() => enforceRoleAcl(ordered, isAdmin), [ordered, isAdmin])
  const formValues = useMemo(() => extractValues(enforced), [enforced])

  const regenerateTokenMutation = useStreamBrokerRegenerateRtspToken()
  const probeStreamMutation = useStreamBrokerProbeStream()
  const testProbeMutation = useDeviceManagerTestCreationField()
  const runDeviceActionTrpc = useDeviceManagerRunDeviceAction()
  const batchMutationTrpc = useDeviceManagerUpdateDeviceFieldsBatch({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['deviceManager', 'getDeviceAggregate']] })
    },
  })
  const batchMutation = {
    isPending: batchMutationTrpc.isPending,
    mutate: (changes: readonly Changeset[]) => {
      batchMutationTrpc.mutate({ deviceId, changes: [...changes] })
    },
  }

  // ── Shared form save controller ──────────────────────────────────
  //
  // Immediate fields (field/section `immediate: true`) auto-save; every
  // other field accumulates in pendingEdits and is flushed via the Save
  // button. See `isImmediateField` for the precedence rules.
  const immediateSave = useCallback(
    (patch: Record<string, unknown>) => {
      const changes = Object.entries(patch)
        .map(([key, value]) => {
          const writer = findWriter(enforced, key)
          return writer
            ? { writerCapName: writer.capName, writerAddonId: writer.addonId, key, value }
            : null
        })
        .filter((c): c is Changeset => c !== null)
      if (changes.length > 0) batchMutation.mutate(changes)
    },
    [enforced, batchMutation],
  )
  // Unlike `immediateSave`, this one REPORTS when the write has landed: it
  // resolves after the mutation settles AND the aggregate has been re-read, so
  // `useFormSaveController` can keep the operator's value on screen for the
  // whole trip. On a Reolink battery camera that trip is a wake, a set and a
  // read-back — seconds — and the field used to snap back to the old value the
  // instant Save was clicked.
  const deferredSave = useCallback(
    async (patch: Record<string, unknown>) => {
      const changes = Object.entries(patch)
        .map(([key, value]) => {
          const writer = findWriter(enforced, key)
          return writer
            ? { writerCapName: writer.capName, writerAddonId: writer.addonId, key, value }
            : null
        })
        .filter((c): c is Changeset => c !== null)
      if (changes.length === 0) return
      try {
        const result = await batchMutationTrpc.mutateAsync({ deviceId, changes })
        // A provider that refused its patch does not fail the call — it is
        // listed. Dropping that list made a refused save indistinguishable
        // from a revert; throwing hands the edit back to the operator.
        if (result.failures.length > 0) {
          throw new Error(result.failures.map((f) => f.error).join('; '))
        }
      } finally {
        await queryClient.invalidateQueries({
          queryKey: [['deviceManager', 'getDeviceAggregate']],
        })
      }
    },
    [enforced, batchMutationTrpc, deviceId, queryClient],
  )
  const formController = useFormSaveController({
    schema: enforced,
    serverValues: formValues,
    onImmediateSave: immediateSave,
    onDeferredSave: deferredSave,
  })
  const {
    values: effectiveValues,
    pendingKeys,
    handleChange,
    handleSave,
    handleDiscard,
  } = formController
  editingPausedRef.current = formController.editingPaused

  const externalSave = useQuickDetailSave()
  const exportSaveRef = useRef(handleSave)
  const exportDiscardRef = useRef(handleDiscard)
  exportSaveRef.current = handleSave
  exportDiscardRef.current = handleDiscard
  const exportRegister = externalSave?.register
  const exportError = batchMutationTrpc.isError
    ? batchMutationTrpc.error instanceof Error
      ? batchMutationTrpc.error.message
      : String(batchMutationTrpc.error)
    : null
  const pendingKeyList = pendingKeys.join('\0')
  useEffect(() => {
    if (exportRegister === undefined) return
    const keys = pendingKeyList === '' ? [] : pendingKeyList.split('\0')
    return exportRegister({
      id: 'export',
      dirty: keys.length > 0,
      saving: batchMutationTrpc.isPending,
      error: exportError,
      save: () => {
        exportSaveRef.current(keys)
        return Promise.resolve()
      },
      discard: () => exportDiscardRef.current(keys),
    })
  }, [exportRegister, pendingKeyList, batchMutationTrpc.isPending, exportError])

  const hasLeadingTabs = leadingTabs !== undefined && leadingTabs.length > 0
  if (isSettingsLoading && !hasLeadingTabs) {
    return (
      <div className="flex items-center justify-center py-12 text-foreground-subtle">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        <span className="text-xs">
          {t('device.deviceAggregateSection.loadingDeviceAggregate', 'Loading device aggregate…')}
        </span>
      </div>
    )
  }

  if (!hasLeadingTabs && (!enforced || enforced.sections.length === 0)) {
    return (
      <div className="text-xs text-foreground-subtle italic py-4 text-center">
        {t(
          'device.deviceAggregateSection.noAggregateContributionsForThis',
          'No aggregate contributions for this device.',
        )}
      </div>
    )
  }

  // Inline-action handler — routes `action` strings emitted by contributed
  // fields into the matching tRPC cap call. The field `key` is the field's
  // storage-shape id ("rtspUrl:main", "mainStreamUrl", ...); we accept any
  // of the known prefixes so the contributor can keep its natural key
  // shape instead of renaming it for this layer.
  //
  // The handler may return a value (e.g. `FieldProbeResult` for the
  // probe field's "test-probe" action) — hence `Promise<unknown>`
  // instead of `Promise<void>`. Callers that don't need a return value
  // still work; callers that do (ProbeField) await the result.
  async function handleAction(action: string, key: string, value?: unknown): Promise<unknown> {
    if (action === 'regenerate-rtsp-token') {
      const prefix = ['rtspUrl:', 'regenerateToken:'].find((p) => key.startsWith(p))
      if (!prefix)
        throw new Error(
          `regenerate-rtsp-token: unrecognised key "${key}" (expected "rtspUrl:<streamId>" or "regenerateToken:<streamId>")`,
        )
      const streamId = key.slice(prefix.length)
      if (!streamId)
        throw new Error(`regenerate-rtsp-token: key "${key}" has no streamId after prefix`)
      const brokerId = makeSourceBrokerId(deviceId, streamId)
      await regenerateTokenMutation.mutateAsync({ brokerId })
      queryClient.invalidateQueries({ queryKey: [['deviceManager', 'getDeviceAggregate']] })
      return
    }
    if (action === 'test-probe') {
      if (!deviceMeta) {
        return {
          status: 'error',
          error: t('device.deviceAggregateSection.metadataNotLoaded'),
        } satisfies FieldProbeResult
      }
      try {
        return (await testProbeMutation.mutateAsync({
          addonId: deviceMeta.addonId,
          type: deviceMeta.type,
          key,
          value,
        })) as FieldProbeResult
      } catch (err) {
        return {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        } satisfies FieldProbeResult
      }
    }
    if (action === 'refresh-probe') {
      const prefix = 'probedInfo:'
      if (!key.startsWith(prefix))
        throw new Error(
          `refresh-probe: unrecognised key "${key}" (expected "probedInfo:<streamId>")`,
        )
      const streamId = key.slice(prefix.length)
      if (!streamId) throw new Error(`refresh-probe: key "${key}" has no streamId after prefix`)
      const brokerId = makeSourceBrokerId(deviceId, streamId)
      const result = await probeStreamMutation.mutateAsync({ brokerId })
      queryClient.invalidateQueries({ queryKey: [['deviceManager', 'getDeviceAggregate']] })
      return result
    }
    if (action === 'device-custom-action') {
      // Generic device custom-action dispatch — `key` carries the action name,
      // `value` the resolved input params. Mirrors the addon `addons.custom`
      // fall-through, but device-scoped via deviceManager.runDeviceAction.
      const actionResult: unknown = await runDeviceActionTrpc.mutateAsync({
        deviceId,
        action: key,
        input: value,
      })
      queryClient.invalidateQueries({ queryKey: [['deviceManager', 'getDeviceAggregate']] })
      return actionResult
    }
    throw new Error(`[device-aggregate] unknown action "${action}"`)
  }

  return (
    <TabbedSettingsForm
      schema={enforced ?? EMPTY_SCHEMA}
      values={effectiveValues}
      pendingKeys={pendingKeys}
      onChange={handleChange}
      onAction={handleAction}
      onSave={handleSave}
      onDiscard={handleDiscard}
      hideSaveBar={externalSave !== null}
      disabled={batchMutation.isPending}
      activeSubTab={activeSubTab}
      onSubTabChange={onSubTabChange}
      flattenTabs={flattenSubTabs}
      leadingTabs={leadingTabs}
      visibilityContext={visibilityContext}
    />
  )
}
