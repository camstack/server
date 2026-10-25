/**
 * NodeAddonsSettingsPanel — settings-redesign Phase 8 successor to
 * `MultiAddonSettingsEditor` + `SingleAddonSettingsPanel`.
 *
 * Fetches the new three-level settings endpoints
 * (`addons.getAddonSettings / getGlobalSettings / getDeviceSettings`)
 * in parallel for a caller-provided list of addon ids and renders one
 * `FormBuilder` per addon stacked under a shared Save / Reset control.
 *
 * Consumers pass:
 *   - `nodeId`: which node to target. `null` means hub.
 *   - `addonIds`: the explicit list of addons to render. Discovery is
 *     the caller's job (Pipeline page uses `PIPELINE_CAPABILITIES`,
 *     Cluster page iterates all addons on the selected node).
 *   - `level`: which of the three settings pairs to call.
 *   - `deviceId`: required only when `level === 'device'`.
 *
 * Addons that return `null` for the requested level (don't implement
 * it) are silently dropped — they don't appear in the panel and don't
 * count toward dirty state.
 *
 * Save semantics (decision A1 from brainstorming):
 *   - One Save button at the top for ALL addons rendered.
 *   - Clicking Save collects dirty values per addon and issues N
 *     parallel `update*Settings` mutations — one per addon with dirty
 *     state. Addons with no changes are skipped.
 *   - On success: refetch all queries so the UI sees the server's
 *     canonical view (hydrated schema with runtime-applied defaults).
 *   - On failure: the mutation's error propagates to the Save button;
 *     individual addon's optimistic state is rolled back by the
 *     refetch. No multi-addon atomic transaction — each addon owns
 *     its own settings store.
 *
 * Reset semantics:
 *   - Clicking Reset refetches all queries and drops local edits.
 *   - There is no "reset to schema defaults" path in this panel —
 *     that was a legacy concept from SingleAddonSettingsPanel; with
 *     the three-level API the canonical "default" is whatever the
 *     server returns on read, and forcing a write-of-defaults would
 *     be wrong (each addon's updater may have side effects beyond
 *     the stored bytes).
 */
import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useQueries, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import type {
  ConfigUISchema,
  ConfigUISchemaWithValues,
  ConfigSection,
  ConfigSectionWithValues,
  ConfigFieldWithValue,
  ConfigField,
} from '@camstack/types'
import { WELL_KNOWN_TAB_MAP } from '@camstack/types'
import { FormSaveBar } from '../form-builder/FormSaveBar'
import { SchemaTabBar } from '../form-builder/SchemaTabBar'
import { StableTabPanel } from '../StableTabPanel'
import {
  AddonFormPane,
  type AddonFormPaneHandle,
  type AddonFormPaneState,
} from '../form-builder/AddonFormPane'
import { filterSchemaByFieldScope, type SettingsFieldScope } from '../../lib/settings-field-scope'
import { shapeSections, shownTab, type SectionShape } from '../../lib/settings-section-shape'
import { type SettingsSurface } from '../../lib/settings-forwarding'

import {
  useAddonSettingsUpdateDeviceSettings,
  useAddonSettingsUpdateGlobalSettings,
  useAddonsList,
  useAudioAnalyzerReprobeAudioEngine,
  useDecoderReprobeHwaccel,
  useSystem,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
export type SettingsLevel = 'global' | 'device'

interface NodeAddonsSettingsPanelProps {
  /** Target node id. `null` or `'hub'` → local hub registry. */
  readonly nodeId: string | null
  /** Addon ids to render, in display order. Caller handles discovery. */
  readonly addonIds: readonly string[]
  /** Which of the three level-specific method pairs to call. */
  readonly level: SettingsLevel
  /** Required when `level === 'device'`. */
  readonly deviceId?: number
  /**
   * Optional capability scope for global-level settings. When provided,
   * the `cap` parameter is forwarded to `getGlobalSettings` so addons
   * can return only the settings relevant to that capability (e.g.
   * `network-access` page passes `'network-access'` so tailscale-client
   * returns `null` for unrelated caps and only exposes mesh settings on
   * the Mesh Networks page). Omit to receive the full schema.
   */
  readonly capability?: string
  /**
   * Optional section ID allowlist. When present, only sections whose
   * `id` matches one of these strings are rendered — used by the
   * Balancer / Failover tabs that want to narrow the orchestrator's
   * addon schema to one logical sub-section. Omit to render every
   * section returned by the addon.
   */
  readonly sectionIds?: readonly string[]
  /**
   * Optional section ID denylist. Applied after {@link sectionIds}. Cluster
   * Settings uses this to drop `cluster` (Ingest / Audio / Motion node
   * pickers) because those live on Balancer with the other singleton roles.
   */
  readonly omitSectionIds?: readonly string[]
  /**
   * Re-group the fetched schema on this surface without changing what is
   * stored: keep only some fields (`fieldKeys`), drop the sections' own
   * titles (`hideSectionChrome` — the host draws a card title), or show a
   * section on another tab (`tabAliases`). See `lib/settings-section-shape.ts`.
   */
  readonly fieldKeys?: SectionShape['fieldKeys']
  readonly hideSectionChrome?: SectionShape['hideSectionChrome']
  readonly tabAliases?: SectionShape['tabAliases']
  /** A label for a tab id, over the well-known one (the merged engine tab). */
  readonly tabLabelOverrides?: Readonly<Record<string, string>>
  /**
   * Optional `section.tab` filter. When present, only sections whose
   * `tab` matches are rendered. Ignored when `extraTabs` is supplied
   * (the internal tab bar drives the filter instead).
   */
  readonly sectionTab?: string
  /**
   * Restrict the rendered fields to one STORE SCOPE.
   *
   * `perNode` for a surface drawn under a node's name, `cluster` for a surface
   * with no node behind it (an addon card, the System page). Omit only where
   * the surface genuinely owns both populations. See
   * `lib/settings-field-scope.ts` for why a surface that renders both is
   * lying about at least one of them.
   */
  readonly fieldScope?: SettingsFieldScope
  /**
   * Render the addon's INTEGRATION-LEVEL settings instead of its whole global
   * schema: the sections it declared in `BaseAddon.integrationSettingSections()`,
   * fetched through `addonSettings.getIntegrationSettings`.
   *
   * The selection is core's, not this panel's — core answers with the declared
   * sections already stripped of `perNode` fields. What this prop adds is a
   * REFUSAL of every mount that would imply a narrower scope than the payload
   * has (a device level, a `deviceId`, a node id, or a `fieldScope`). Saves
   * still go through `updateGlobalSettings`, which is why the store key is the
   * same one the addon's own page writes. See `lib/settings-forwarding.ts`.
   */
  readonly surface?: SettingsSurface
  /**
   * Replaces the generic "Nothing to configure here" line. A surface that
   * narrows its population with `fieldScope` must say WHY it is empty and
   * where the rest of the settings went — an unexplained blank reads as a
   * failed load.
   */
  readonly emptyMessage?: string
  /**
   * When provided the panel renders its own tab bar. The bar is the
   * union of `section.tab` values across every fetched addon schema
   * interleaved with these extras. Active tab state lives inside the
   * panel. Use this to host non-schema surfaces (assignments / tree /
   * models) on the same bar as the settings tabs — no separate
   * top-level component needed.
   */
  readonly extraTabs?: readonly ExtraTab[]
  /**
   * Render the schema-derived tab bar even with no `extraTabs`.
   *
   * Self-tabbing used to be inferred from `extraTabs.length > 0` alone, which
   * silently coupled "I host non-schema surfaces" to "I want tabs". A caller
   * with only schema sections (the Cluster node's Settings tab) therefore got
   * NO bar and every `section.tab` group stacked vertically — one heading
   * after another down the panel. Tabs are a property of the layout, not of
   * whether extra content happens to exist, so they get their own prop.
   */
  readonly selfTabbed?: boolean
  /**
   * Controlled active tab for the self-tabbed bar (e.g. bound to a URL param,
   * so a link can land on one tab and a reload keeps it). Absent ⇒ the panel
   * keeps the active tab in its own state.
   */
  readonly activeTab?: string | null
  readonly onActiveTabChange?: (tabId: string) => void
  /**
   * Custom content grafted onto an EXISTING schema tab (a `section.tab`
   * id), rendered inline alongside that tab's derived form panes — not as
   * a separate tab. Use this when a non-schema surface conceptually belongs
   * UNDER a settings tab rather than beside it (e.g. the multi-device
   * accelerator board sits on the same "Inference Engine" tab as the
   * "Object detection" form, so the operator sees one Inference Engine
   * header, not two). `extraTabs` add their OWN tab; `schemaTabExtras`
   * decorate a schema tab that already exists.
   */
  readonly schemaTabExtras?: readonly SchemaTabExtra[]
  /**
   * Optional heading shown above the addon list. Each addon still has
   * its own sub-heading from `ConfigSection.title`.
   */
  readonly title?: string
  /** Optional description shown under the main title. */
  readonly description?: string
}

export interface ExtraTab {
  readonly id: string
  readonly label: string
  /** Lower values sort left. Schema tabs sort via WELL_KNOWN_TAB order. */
  readonly order?: number
  readonly content: React.ReactNode
}

export interface SchemaTabExtra {
  /** The `section.tab` id to decorate (e.g. `'engine'`). */
  readonly tabId: string
  /** Rendered before (default) or after the tab's derived form panes. */
  readonly placement?: 'before' | 'after'
  readonly content: React.ReactNode
}

// ---------------------------------------------------------------------------
// Helper: split a `ConfigUISchemaWithValues` into `{ schema, values }`
//
// The existing `FormBuilder` accepts `(ConfigUISchema, values)` so we strip
// the inline `value` from every leaf field to recover the legacy shape and
// collect a flat key → value map in parallel. Group fields recurse. Unknown
// / valueless fields (separator, info, button) pass through without
// contributing to the values map.
// ---------------------------------------------------------------------------

interface StrippedSchema {
  readonly schema: ConfigUISchema
  readonly values: Record<string, unknown>
}

function stripFieldValue(
  field: ConfigFieldWithValue,
  values: Record<string, unknown>,
): ConfigField {
  // Structural fields with no `value` — pass through unchanged.
  if (field.type === 'separator' || field.type === 'info' || field.type === 'button') {
    return field as ConfigField
  }
  // Group field: recurse into children, keep the wrapper.
  if (field.type === 'group') {
    const strippedChildren = field.fields.map((child) => stripFieldValue(child, values))
    // The cast is safe by construction — the group has no own `value`,
    // only a `fields` array whose elements we just normalised.
    return { ...field, fields: strippedChildren } as ConfigField
  }
  // Leaf field with an inline value. Record it in the flat map and
  // strip the `value` key from the output so the FormBuilder's field
  // renderer reads via `values[field.key]` (the existing contract).
  const withValue = field as ConfigFieldWithValue & { value?: unknown }
  values[field.key] = withValue.value
  const { value: _value, ...rest } = withValue
  void _value
  return rest as ConfigField
}

function stripSectionValues(
  section: ConfigSectionWithValues,
  values: Record<string, unknown>,
): ConfigSection {
  return {
    ...section,
    fields: section.fields.map((f) => stripFieldValue(f, values)),
  }
}

function splitSchemaWithValues(schemaWithValues: ConfigUISchemaWithValues): StrippedSchema {
  const values: Record<string, unknown> = {}
  const schema: ConfigUISchema = {
    ...(schemaWithValues.tabs ? { tabs: schemaWithValues.tabs } : {}),
    sections: schemaWithValues.sections.map((s) => stripSectionValues(s, values)),
  }
  return { schema, values }
}

// ---------------------------------------------------------------------------
// Per-addon pane entry — read-only server-side payload that AddonFormPane
// renders. Edit/dirty state is owned internally by each pane's
// useFormSaveController; the parent only aggregates pending state via the
// onStateChange callback (one shape per pane keyed by addonId).
// ---------------------------------------------------------------------------

interface AddonPaneEntry {
  readonly addonId: string
  /** Filtered schema (sectionIds allowlist applied; keeps inline values). */
  readonly schemaWithValues: ConfigUISchemaWithValues
  /** Schema with values stripped — for tab/section discovery. */
  readonly schema: ConfigUISchema
  /** Flat key→value map of the server-authoritative values. */
  readonly serverValues: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NodeAddonsSettingsPanel({
  nodeId,
  addonIds,
  level,
  deviceId,
  capability,
  sectionIds,
  omitSectionIds,
  fieldKeys,
  hideSectionChrome,
  tabAliases,
  tabLabelOverrides,
  sectionTab: controlledSectionTab,
  fieldScope,
  surface,
  emptyMessage,
  extraTabs,
  schemaTabExtras,
  title,
  description,
  selfTabbed: selfTabbedProp,
  activeTab: controlledActiveTab,
  onActiveTabChange,
}: NodeAddonsSettingsPanelProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const trpcClient = useSystem().trpcClient
  const updateGlobalMutation = useAddonSettingsUpdateGlobalSettings()
  const updateDeviceMutation = useAddonSettingsUpdateDeviceSettings()
  const reprobeHwaccelMutation = useDecoderReprobeHwaccel()
  const reprobeAudioEngineMutation = useAudioAnalyzerReprobeAudioEngine()

  // `selfTabbed` mode: panel renders its own tab bar (dynamic tabs from
  // section.tab union + extra tabs). Active tab state lives here. When
  // the operator is on a schema-derived tab, it drives the sectionTab
  // filter internally — the `sectionTab` prop is ignored in this mode.
  const selfTabbed = selfTabbedProp === true || Boolean(extraTabs && extraTabs.length > 0)
  const [internalActiveTab, setInternalActiveTab] = useState<string | null>(null)

  // Guard against misuse at call sites — Phase 8 spec: device level
  // requires a deviceId. Fail fast rather than silently skipping.
  if (level === 'device' && !deviceId) {
    throw new Error('NodeAddonsSettingsPanel: deviceId is required when level === "device"')
  }

  // Integration-level settings are addon-wide by construction. Each refusal
  // below is a mount that would silently re-scope them; they throw rather than
  // warn because every one renders a plausible-looking form that writes
  // somewhere the operator did not mean.
  if (surface !== undefined) {
    // `level: 'device'` / a `deviceId` is the `ProviderSettingsTab` defect: an
    // addon-wide schema under ONE camera's heading, where editing the SMTP
    // port from camera 102 reconfigures every Reolink.
    if (level !== 'global' || deviceId !== undefined) {
      throw new Error(
        'NodeAddonsSettingsPanel: integration-level settings are addon-wide — they cannot be ' +
          'mounted at device level or with a deviceId. A second page, never a second scope.',
      )
    }
    // A node id is the `AddonCard` defect: `nodeId="hub"` wrote `<key>@hub`
    // while the same label on the node card wrote `<key>@<thatNode>`.
    if (nodeId !== null) {
      throw new Error(
        'NodeAddonsSettingsPanel: an integration has no node behind it — pass nodeId={null}. ' +
          `Received ${JSON.stringify(nodeId)}.`,
      )
    }
    // Core already stripped `perNode` from this payload; a caller-supplied
    // scope is the "two knobs that disagree" shape even when it happens to
    // agree, and it would be applied to a schema that no longer needs it.
    if (fieldScope !== undefined) {
      throw new Error(
        'NodeAddonsSettingsPanel: integration-level settings arrive already cluster-scoped from ' +
          'core — remove `fieldScope` rather than restating it.',
      )
    }
  }

  const effectiveNodeId = nodeId ?? 'hub'

  // ── Parallel fetches ─────────────────────────────────────────────
  // `useQueries` lets us issue one tRPC call per addonId without
  // violating hook rules (all at once, keys derived from addonIds).
  const queries = useQueries({
    queries: addonIds.map((addonId) => ({
      queryKey: [
        [
          'addonSettings',
          surface !== undefined
            ? 'getIntegrationSettings'
            : level === 'global'
              ? 'getGlobalSettings'
              : 'getDeviceSettings',
        ],
        {
          addonId,
          nodeId: effectiveNodeId,
          deviceId: deviceId ?? null,
          cap: capability ?? null,
          // Two surfaces over the same addon can want different populations
          // (a node card wants `perNode`, an addon card wants `cluster`), and
          // the scoped payloads must not share a cache entry.
          scope: fieldScope ?? null,
        },
      ],
      queryFn: async (): Promise<{ addonId: string; result: ConfigUISchemaWithValues | null }> => {
        // Scoping is applied HERE, at the edge, so every derived thing below
        // — the tab bar, the fingerprint, the panes, the dirty set — sees one
        // consistent schema. Filtering later would leave a tab bar advertising
        // tabs whose fields had already been dropped.
        const scoped = (raw: ConfigUISchemaWithValues | null): ConfigUISchemaWithValues | null =>
          raw !== null && fieldScope !== undefined ? filterSchemaByFieldScope(raw, fieldScope) : raw
        // An integration surface asks CORE for the addon's declared sections.
        // The narrowing is not repeated here on purpose: a client-side filter
        // beside the server-side one is a second opinion about which settings
        // are integration-level, and the two would eventually disagree.
        if (surface !== undefined) {
          const result = await trpcClient.addonSettings.getIntegrationSettings.query({
            addonId,
            nodeId: effectiveNodeId,
          })
          return { addonId, result: result as ConfigUISchemaWithValues | null }
        }
        if (level === 'global') {
          const result = await trpcClient.addonSettings.getGlobalSettings.query({
            addonId,
            nodeId: effectiveNodeId,
            ...(capability ? { cap: capability } : {}),
          })
          return { addonId, result: scoped(result as ConfigUISchemaWithValues | null) }
        }
        const result = await trpcClient.addonSettings.getDeviceSettings.query({
          addonId,
          deviceId: deviceId!,
          nodeId: effectiveNodeId,
        })
        return { addonId, result: scoped(result as ConfigUISchemaWithValues | null) }
      },
      // An engine-cascade save restarts the addon; the invalidation refetch
      // races that restart window where getGlobalSettings returns null. Keep
      // the previous data on screen while refetching so the pane never flashes
      // empty mid-restart. A resolved null is additionally absorbed by the
      // last-good fallback in `paneEntries`.
      placeholderData: keepPreviousData,
    })),
  })

  const isLoading = queries.some((q) => q.isLoading)

  // `useQueries` returns a brand-new array on every render, so a
  // `useMemo(..., [queries])` below would never hit the cache — its
  // output would re-seed `panes` via the effect, which triggers
  // another render, which rebuilds `queries`, which re-runs the memo,
  // etc. React surfaces the loop as "Maximum update depth exceeded".
  //
  // We stabilise the memo dependency via a single string hash over
  // the materialised `data` payloads (React-Query memoises these per
  // query, so the hash is stable across renders when the server
  // response hasn't changed). The hash is a fixed-length string so
  // React's deps-array invariant holds.
  // Fingerprint every query's actual schema payload (not just
  // loaded/not-loaded) so the memo below re-runs whenever the refetched
  // data changes — e.g. detection-pipeline's cascade dropdowns narrow
  // `engineBackend` options after the operator flips `engineRuntime`,
  // OR a plain Save round-trip flips a field's persisted `value` (the
  // common case: change a dropdown, mutation invalidates the query,
  // refetch lands → without the value in this hash, `paneEntries`
  // would not rebuild and the form would keep rendering the OLD
  // `serverValues` until a hard page reload).
  const queriesDataHash = queries
    .map((q) => {
      if (!q.data) return '-'
      if (q.data.result === null) return `${q.data.addonId}:n`
      // Schema change: track section ids + field keys + persisted
      // values + select options. Values changing is the bread-and-
      // butter case (Save → refetch). Options changing is the cascade
      // case (`engineRuntime → engineBackend` narrowing). Both must
      // bump the hash to keep `paneEntries` in sync.
      const parts: string[] = []
      for (const s of q.data.result.sections) {
        parts.push(`s:${s.id}:${s.tab ?? 'general'}`)
        for (const f of s.fields) {
          if (!('key' in f)) continue
          const opts =
            'options' in f && Array.isArray((f as { options?: readonly unknown[] }).options)
              ? (f as { options: readonly { value: string }[] }).options
                  .map((o) => o.value)
                  .join(',')
              : ''
          // `value` may be any JSON-serialisable type (string, number,
          // boolean, object). Stringify defensively — Object/array
          // values stringify deterministically enough for fingerprint
          // purposes; the hash only needs equal-vs-not, not a stable
          // canonical form.
          const rawValue = (f as { value?: unknown }).value
          const valueRepr =
            rawValue === undefined
              ? ''
              : typeof rawValue === 'string'
                ? rawValue
                : JSON.stringify(rawValue)
          parts.push(`f:${(f as { key: string }).key}:${opts}:${valueRepr}`)
        }
      }
      return `${q.data.addonId}:${parts.join('|')}`
    })
    .join('||')

  // Union of section.tab across all fetched schemas — drives the
  // self-tabbed bar. Stable deps via queriesDataHash + the tab strings
  // hash so Refetch → membership update → memo invalidates → bar rerenders.
  const schemaTabIds = useMemo<readonly string[]>(() => {
    const set = new Set<string>()
    for (const q of queries) {
      const sections = q.data?.result?.sections
      if (!sections) continue
      for (const s of sections) set.add(shownTab(s.tab, tabAliases))
    }
    return [...set]
  }, [
    tabAliases,
    queriesDataHash +
      '::' +
      queries
        .map((q) => (q.data?.result?.sections ?? []).map((s) => s.tab ?? 'general').join(','))
        .join('::'),
  ])

  // Composite tab list shown in the bar. Schema tabs + extras sorted by
  // WELL_KNOWN_TAB order, then by explicit extra.order, then alphabetical.
  const extraTabMap = useMemo(() => new Map((extraTabs ?? []).map((t) => [t.id, t])), [extraTabs])
  // `schemaTabExtras` decorate an EXISTING schema tab, but the schema section
  // that owns it may not have loaded yet (or the addon may be absent on this
  // node). Fold their tab ids into the bar so the decorated tab always has a
  // home — it renders the extra content even before/without any form panes.
  const orderedTabIds = useMemo<readonly string[]>(() => {
    if (!selfTabbed) return []
    const ids = [
      ...new Set([
        ...schemaTabIds,
        ...(extraTabs ?? []).map((t) => t.id),
        ...(schemaTabExtras ?? []).map((e) => e.tabId),
      ]),
    ]
    const orderOf = (id: string): number => {
      const extra = extraTabMap.get(id)
      if (extra?.order !== undefined) return extra.order
      const wk = WELL_KNOWN_TAB_MAP[id as keyof typeof WELL_KNOWN_TAB_MAP]
      if (wk) return wk.order
      return 50
    }
    return ids.toSorted((a, b) => {
      const da = orderOf(a)
      const db = orderOf(b)
      if (da !== db) return da - db
      return a.localeCompare(b)
    })
  }, [selfTabbed, schemaTabIds, extraTabs, extraTabMap, schemaTabExtras])

  const tabLabels = useMemo<ReadonlyMap<string, string>>(() => {
    const m = new Map<string, string>()
    const labelFromWellKnown = (id: string): string => {
      const wk = WELL_KNOWN_TAB_MAP[id as keyof typeof WELL_KNOWN_TAB_MAP]
      return wk?.label ?? id.charAt(0).toUpperCase() + id.slice(1)
    }
    for (const id of schemaTabIds) m.set(id, labelFromWellKnown(id))
    for (const e of schemaTabExtras ?? []) {
      if (!m.has(e.tabId)) m.set(e.tabId, labelFromWellKnown(e.tabId))
    }
    for (const t of extraTabs ?? []) m.set(t.id, t.label)
    for (const [id, label] of Object.entries(tabLabelOverrides ?? {})) m.set(id, label)
    return m
  }, [schemaTabIds, extraTabs, schemaTabExtras, tabLabelOverrides])

  // Resolve active tab. In selfTabbed mode the internal state is
  // authoritative; external `sectionTab` is ignored because the bar
  // drives the filter. Non-selfTabbed callers keep the controlled
  // `sectionTab` they already pass in.
  const requestedTab = controlledActiveTab !== undefined ? controlledActiveTab : internalActiveTab
  const activeTab = selfTabbed
    ? requestedTab && orderedTabIds.includes(requestedTab)
      ? requestedTab
      : (orderedTabIds[0] ?? null)
    : null
  const selectTab = (tabId: string): void => {
    setInternalActiveTab(tabId)
    onActiveTabChange?.(tabId)
  }
  const activeTabIsExtra = activeTab !== null && extraTabMap.has(activeTab)
  const effectiveSectionTab = selfTabbed
    ? activeTab && !activeTabIsExtra
      ? activeTab
      : undefined
    : controlledSectionTab

  // Fetch the addon manifest list once so we can decorate each pane
  // header with the package displayName instead of the raw addonId.
  // The query is shared cluster-wide and cached for 60s — this is
  // cheap and doesn't block the settings queries above.
  const { data: addonList } = useAddonsList(undefined)

  const addonDisplayNames = useMemo<ReadonlyMap<string, string>>(() => {
    const out = new Map<string, string>()
    for (const entry of addonList ?? []) {
      const id = entry.manifest?.id
      if (!id) continue
      // `[ADDON-DISPLAY-NAME]` — prefer the per-addon `manifest.name`
      // ("Local Backup", "Metrics Native", ...) over the bundle-wide
      // `packageDisplayName` ("Core"). Bundle packages like
      // `@camstack/system` ship many addons under one displayName, and
      // using the bundle name made every pane read "Core"
      // instead of the actual addon. Fall back to `packageDisplayName`
      // when an addon hasn't set a human-readable name of its own,
      // and to the id when neither is set.
      const display = entry.manifest?.name ?? entry.manifest?.packageDisplayName ?? id
      out.set(id, display)
    }
    return out
  }, [addonList])

  // ── Build per-addon pane entries from the latest query payloads ──
  // Schema state is derived; pending edits live inside each
  // AddonFormPane's useFormSaveController. The parent only aggregates
  // pendingKeys via the onStateChange callback.
  //
  // Last good (non-null) schema per addonId. Lets a pane survive the ~1s
  // restart window after an engine-cascade save, where getGlobalSettings
  // returns null ("unavailable"), without dropping the pane or collapsing
  // its option lists.
  const lastGoodResultRef = useRef(new Map<string, ConfigUISchemaWithValues>())
  const paneEntries = useMemo<readonly AddonPaneEntry[]>(() => {
    const allow = sectionIds ? new Set(sectionIds) : null
    const omit = omitSectionIds ? new Set(omitSectionIds) : null
    const keepSection = (id: string): boolean => {
      if (allow !== null && !allow.has(id)) return false
      if (omit !== null && omit.has(id)) return false
      return true
    }
    const out: AddonPaneEntry[] = []
    for (const q of queries) {
      if (!q.data) continue
      // `result === null` means the addon can't serve settings right now
      // (mid-restart after an engine-cascade save). Fall back to the last
      // good schema for this addon so the pane keeps its values + options +
      // probe instead of vanishing/collapsing for the ~1s restart window.
      // Update the cache only on a real (non-null) payload.
      const result = q.data.result ?? lastGoodResultRef.current.get(q.data.addonId) ?? null
      if (q.data.result !== null) {
        lastGoodResultRef.current.set(q.data.addonId, q.data.result)
      }
      if (result === null) continue
      const { schema, values } = splitSchemaWithValues(result)
      const shape: SectionShape = {
        ...(fieldKeys !== undefined ? { fieldKeys } : {}),
        ...(hideSectionChrome !== undefined ? { hideSectionChrome } : {}),
        ...(tabAliases !== undefined ? { tabAliases } : {}),
      }
      const filteredSections = shapeSections(
        schema.sections.filter((s) => keepSection(s.id)),
        shape,
      )
      if (filteredSections.length === 0) continue
      // Re-build the schema-with-values shape with the same filter
      // applied. AddonFormPane uses both: the with-values shape feeds
      // useFormSaveController's section walk for `immediate` flags;
      // serverValues is the flat overlay base.
      const filteredWithValues: ConfigUISchemaWithValues = {
        ...result,
        sections: shapeSections(
          result.sections.filter((s) => keepSection(s.id)),
          shape,
        ),
      }
      const filteredSchema: ConfigUISchema = { ...schema, sections: filteredSections }
      out.push({
        addonId: q.data.addonId,
        schemaWithValues: filteredWithValues,
        schema: filteredSchema,
        serverValues: values,
      })
    }
    return out
  }, [queriesDataHash, sectionIds, omitSectionIds, fieldKeys, hideSectionChrome, tabAliases])

  // Pending state by addonId, fed by AddonFormPane.onStateChange.
  // Cleared lazily — entries for unmounted panes can stay until the
  // next state event; pendingCount derivations only consider
  // currently-mounted addonIds via paneEntries.
  const [paneStates, setPaneStates] = useState<ReadonlyMap<string, AddonFormPaneState>>(new Map())
  const handlePaneStateChange = useCallback((state: AddonFormPaneState) => {
    setPaneStates((prev) => {
      const next = new Map(prev)
      next.set(state.addonId, state)
      return next
    })
  }, [])

  // Imperative handles per pane — used by saveMutation/resetLocal to
  // flush/discard each pane's pending overlay in one batch.
  const paneRefs = useRef(new Map<string, AddonFormPaneHandle>())
  const setPaneRef = useCallback(
    (addonId: string) => (handle: AddonFormPaneHandle | null) => {
      if (handle) paneRefs.current.set(addonId, handle)
      else paneRefs.current.delete(addonId)
    },
    [],
  )

  /** Fire an immediate save for a single addon with the given values. */
  const immediateAddonSave = useCallback(
    async (addonId: string, patch: Record<string, unknown>) => {
      if (level === 'global') {
        await updateGlobalMutation.mutateAsync({
          addonId,
          nodeId: effectiveNodeId,
          patch,
        })
      } else {
        await updateDeviceMutation.mutateAsync({
          addonId,
          deviceId: deviceId!,
          nodeId: effectiveNodeId,
          patch,
        })
      }
      void queryClient.invalidateQueries({ queryKey: [['addonSettings']] })
    },
    [updateGlobalMutation, updateDeviceMutation, effectiveNodeId, level, deviceId, queryClient],
  )

  /**
   * Route an inline field action (`actions: [...]` on a schema field)
   * to the right tRPC mutation. Addons declare the action by name in
   * their schema; the panel owns the mapping to a real cap call so
   * addons stay free of frontend concerns. Invalidates every settings
   * query on success so the dependent fields pick up the newly-written
   * values without a page reload.
   */
  const handleFieldAction = useCallback(
    async (addonId: string, action: string, _key: string, value?: unknown): Promise<unknown> => {
      const effective = effectiveNodeId
      try {
        switch (action) {
          case 'reprobe-hwaccel':
            await reprobeHwaccelMutation.mutateAsync({ nodeId: effective })
            void queryClient.invalidateQueries({ queryKey: [['addonSettings']] })
            return
          case 'reprobe-audio-engine':
            await reprobeAudioEngineMutation.mutateAsync({ nodeId: effective })
            void queryClient.invalidateQueries({ queryKey: [['addonSettings']] })
            return
          default: {
            // Fall through to the generic customAction dispatcher —
            // any addon-action-{select,button} field type ends up here.
            // The action handler may write settings (e.g. enableCustom
            // persists tunnel state), so invalidate addonSettings on
            // success so the form re-renders with the new values.
            const result = await trpcClient.addons.custom.mutate({
              addonId,
              action,
              input: value,
            })
            void queryClient.invalidateQueries({ queryKey: [['addonSettings']] })
            return result
          }
        }
      } catch (err) {
        console.error('[NodeAddonsSettingsPanel] action failed', { addonId, action, err })
        throw err
      }
    },
    [reprobeHwaccelMutation, reprobeAudioEngineMutation, effectiveNodeId, queryClient, trpcClient],
  )

  // Fired from inside an AddonFormPane when an `immediate: true`
  // field changes. Routes to the same per-addon update mutation as
  // the deferred Save path.
  const handleImmediatePaneSave = useCallback(
    (addonId: string, patch: Record<string, unknown>) => {
      void immediateAddonSave(addonId, patch)
    },
    [immediateAddonSave],
  )

  // ── Save mutation: one call per dirty pane, in parallel ──────────
  // Reads pending edits from `paneStates` (the snapshot fed by each
  // pane's onStateChange) instead of calling handle.flush() up-front.
  // This way a failed mutation leaves every pane's pending overlay
  // intact — the operator can retry without re-typing. On success the
  // saved addonIds get a handle.discard() to clear their overlay.
  const saveMutation = useMutation({
    mutationFn: async () => {
      const patches: Array<{ addonId: string; patch: Record<string, unknown> }> = []
      for (const entry of paneEntries) {
        const state = paneStates.get(entry.addonId)
        if (!state || state.pendingKeys.length === 0) continue
        patches.push({ addonId: entry.addonId, patch: state.pendingValues })
      }
      if (patches.length === 0) return { saved: [] as string[] }
      const saved = await Promise.all(
        patches.map(async ({ addonId, patch }) => {
          if (level === 'global') {
            await updateGlobalMutation.mutateAsync({
              addonId,
              nodeId: effectiveNodeId,
              patch,
            })
          } else {
            await updateDeviceMutation.mutateAsync({
              addonId,
              deviceId: deviceId!,
              nodeId: effectiveNodeId,
              patch,
            })
          }
          return addonId
        }),
      )
      return { saved }
    },
    onSuccess: ({ saved }) => {
      for (const addonId of saved) {
        const handle = paneRefs.current.get(addonId)
        handle?.discard()
      }
      void queryClient.invalidateQueries({ queryKey: [['addonSettings']] })
    },
  })

  const resetLocal = useCallback(() => {
    // Drop every pane's pending overlay. AddonFormPane.discard()
    // resets the controller's pending edits without firing any
    // mutation. The next render shows server values verbatim.
    for (const handle of paneRefs.current.values()) {
      handle.discard()
    }
  }, [])

  // ── Derivations (must run unconditionally so hook order stays stable
  //    across renders, regardless of the early-return branches below). ─

  // Count of pending fields across every pane — drives the floating
  // save bar's "N unsaved change(s)" summary. Immediate fields never
  // reach the pending overlay (controller flushes them via
  // onImmediateSave); the pendingKeys array reported by each pane only
  // counts deferred edits.
  const pendingCount = useMemo(() => {
    let acc = 0
    for (const entry of paneEntries) {
      const state = paneStates.get(entry.addonId)
      if (state) acc += state.pendingKeys.length
    }
    return acc
  }, [paneEntries, paneStates])

  // Per-tab pending counter — powers the SchemaTabBar "pending" dot.
  // Map every pending key to its owning section's tab via the pane's
  // filtered schema.
  const pendingByTab = useMemo<ReadonlyMap<string, number>>(() => {
    const m = new Map<string, number>()
    for (const entry of paneEntries) {
      const state = paneStates.get(entry.addonId)
      if (!state || state.pendingKeys.length === 0) continue
      const pending = new Set(state.pendingKeys)
      for (const section of entry.schema.sections) {
        const tabId = section.tab ?? 'general'
        for (const field of section.fields) {
          if (!('key' in field)) continue
          if (pending.has(field.key)) {
            m.set(tabId, (m.get(tabId) ?? 0) + 1)
          }
        }
      }
    }
    return m
  }, [paneEntries, paneStates])

  // ── Render ────────────────────────────────────────────────────────
  if (isLoading) {
    return <div className="h-24 rounded-lg border border-border bg-surface animate-pulse" />
  }

  const activeExtra = activeTab && activeTabIsExtra ? extraTabMap.get(activeTab) : undefined

  // Non-selfTabbed caller with no panes → classic empty state. In
  // selfTabbed mode we fall through: the active tab may be an extra
  // (whose content we still want to render) or a schema tab that
  // simply has no sections on this node (show placeholder inside the
  // tab body instead of the whole component collapsing).
  if (!selfTabbed && paneEntries.length === 0) {
    return (
      <div className="text-[11px] text-foreground-subtle italic">
        {emptyMessage ??
          t('settings.nodeAddonsSettingsPanel.noAddonsIn', {
            scope:
              addonIds.length > 0
                ? `[${addonIds.join(', ')}]`
                : t(
                    'settings.nodeAddonsSettingsPanel.theCurrentSelection',
                    'the current selection',
                  ),
            level,
          })}
      </div>
    )
  }

  const isSaving = saveMutation.isPending

  return (
    <div className="space-y-4">
      {/* Header: optional title + description only. Save/Reset moved to
          the sticky bottom bar (mirrors the Device Details pattern) so
          the controls stay reachable even on long forms without the
          operator having to scroll back up. */}
      {(title || description) && (
        <div className="border-b border-border pb-2">
          {title && <h2 className="text-sm font-semibold text-foreground">{title}</h2>}
          {description && (
            <p className="text-[11px] text-foreground-subtle mt-0.5">{description}</p>
          )}
        </div>
      )}

      {/* Self-tabbed top bar — dynamic tabs from section.tab union +
          extra tabs. Active state lives inside the panel. Rendering
          delegated to the shared SchemaTabBar (same component Device
          Details uses) so styling stays uniform. */}
      {selfTabbed && (
        <SchemaTabBar
          tabs={orderedTabIds.map((id) => ({ id, label: tabLabels.get(id) ?? id }))}
          activeId={activeTab}
          onChange={selectTab}
          pendingByTab={pendingByTab}
        />
      )}

      {saveMutation.isError && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-400">
          {t('settings.nodeAddonsSettingsPanel.saveFailed', 'Save failed:')}{' '}
          {String((saveMutation.error as Error)?.message ?? saveMutation.error)}
        </div>
      )}

      {/* Hold the outgoing panel's height across a tab switch. Even the
          mount-everything-and-`display:none` scheme below changes total height on
          every switch (a hidden node contributes zero), and an `extraTab` swap is
          a real unmount. On a phone that height delta clamps the scroll container
          to the top — see StableTabPanel. */}
      <StableTabPanel tabKey={activeExtra ? `extra:${activeTab ?? ''}` : `tab:${activeTab ?? ''}`}>
        {activeExtra
          ? activeExtra.content
          : (() => {
              // Visible entries = paneEntries filtered + retitled for the
              // active tab. AddonFormPane owns its own pending overlay
              // internally, so a tab switch on the parent simply unmounts
              // the panes in the inactive tab — but the controller is
              // recreated on remount, dropping pending overlay. To preserve
              // edits across tab switches we mount EVERY pane and hide
              // (display:none) the ones that don't match the active tab.
              // The visiblePanes array below stays the source of truth for
              // pendingByTab + ordering.
              // Count how many sections will land on the active tab across
              // ALL panes — when ≥2, keep section titles + descriptions so
              // operators can tell co-located sections apart (e.g.
              // detection-pipeline's "Object detection" sitting next to
              // audio-analyzer's "Audio inference engine" under the same
              // "Inference Engine" tab). When exactly 1 section is visible,
              // strip them — the tab title alone is enough and rendering a
              // duplicate section header looks redundant.
              const sectionsOnActiveTab = effectiveSectionTab
                ? paneEntries.reduce(
                    (acc, p) =>
                      acc +
                      p.schemaWithValues.sections.filter(
                        (s) => (s.tab ?? 'general') === effectiveSectionTab,
                      ).length,
                    0,
                  )
                : 0
              // Only a TAB title can stand in for a section title. With no tab
              // scope (`sectionTab` unset → `undefined`, which a `!== null`
              // test let through) every caller lost every section heading,
              // and a collapsed accordion lost the header that opens it.
              const stripChrome = Boolean(effectiveSectionTab) && sectionsOnActiveTab <= 1

              const visibleEntries = paneEntries
                .map((p) => ({
                  ...p,
                  // Filter the schema-with-values shape for rendering.
                  renderedWithValues: {
                    ...p.schemaWithValues,
                    sections: p.schemaWithValues.sections
                      .filter((s) =>
                        effectiveSectionTab ? (s.tab ?? 'general') === effectiveSectionTab : true,
                      )
                      .map((s) => (stripChrome ? { ...s, title: '', description: undefined } : s)),
                  },
                }))
                .filter((p) => p.renderedWithValues.sections.length > 0)
                // Cross-pane ordering: when multiple panes contribute to the
                // same tab, sort by the *minimum* `section.order` each pane's
                // visible sections declare. Lets addons control rendering
                // order via the schema (lower goes first) without coupling
                // the panel to addon ids. Falls back to insertion order
                // (matches the previous behaviour for tabs with one section
                // per pane).
                .toSorted((a, b) => {
                  const orderOf = (sections: readonly { order?: number }[]): number => {
                    let best = Number.POSITIVE_INFINITY
                    for (const s of sections) {
                      if (typeof s.order === 'number' && s.order < best) best = s.order
                    }
                    return best
                  }
                  const oa = orderOf(a.renderedWithValues.sections)
                  const ob = orderOf(b.renderedWithValues.sections)
                  if (oa !== ob) return oa - ob
                  return 0
                })
              // Custom surfaces grafted onto THIS schema tab (e.g. the
              // multi-device accelerator board on the "engine" tab). They render
              // inline with the derived form panes so the tab keeps one header.
              const tabExtras = (schemaTabExtras ?? []).filter(
                (e) => e.tabId === effectiveSectionTab,
              )
              const extrasBefore = tabExtras.filter((e) => (e.placement ?? 'before') === 'before')
              const extrasAfter = tabExtras.filter((e) => e.placement === 'after')

              if (visibleEntries.length === 0 && tabExtras.length === 0) {
                return (
                  <div className="text-[11px] text-foreground-subtle italic">
                    {emptyMessage ??
                      t(
                        'settings.nodeAddonsSettingsPanel.nothingToConfigureHereFor',
                        'Nothing to configure here for this node.',
                      )}
                  </div>
                )
              }
              return (
                <div className="space-y-6">
                  {extrasBefore.map((extra, i) => (
                    <div key={`extra-before-${i}`}>{extra.content}</div>
                  ))}
                  {visibleEntries.length > 0 && (
                    <TabbedAddonPanes
                      entries={visibleEntries}
                      paneStates={paneStates}
                      displayNames={addonDisplayNames}
                      disabled={isSaving}
                      setPaneRef={setPaneRef}
                      onPaneStateChange={handlePaneStateChange}
                      onImmediateSave={handleImmediatePaneSave}
                      onAction={handleFieldAction}
                      inline={selfTabbed || Boolean(controlledSectionTab)}
                    />
                  )}
                  {extrasAfter.map((extra, i) => (
                    <div key={`extra-after-${i}`}>{extra.content}</div>
                  ))}
                </div>
              )
            })()}
      </StableTabPanel>

      {/* Floating save bar — panel-level, renders LAST so `sticky
          bottom-0` pins it to the viewport bottom while the form
          scrolls behind. Stays visible across tab switches so the
          operator can edit in one tab, navigate to another (even an
          extraTab), and commit everything together. Engine cascade
          fields bypass this bar entirely — they `immediate: true`-flush
          on change. */}
      {!isLoading && (
        <FormSaveBar
          pendingCount={pendingCount}
          onSave={() => saveMutation.mutate()}
          onDiscard={resetLocal}
          saving={isSaving}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tabbed pane rendering — one tab per addon
// ---------------------------------------------------------------------------

/**
 * Render one tab per addon contributing settings. Previously the panel
 * stacked every addon's FormBuilder vertically in a single page; with
 * 8-10 addons (system-config + every installed feature) the page grew
 * unwieldy and operators had to scroll past every section just to reach
 * the one they wanted. A tab bar — same shape as the device-details
 * aggregate — scopes the form to one addon at a time.
 *
 * Sort order: `system-config` first (cluster-wide yml sections most
 * operators check first), then alphabetical by displayName.
 *
 * Pending state preservation: every pane is mounted unconditionally;
 * the inactive ones are hidden via `display: none`. AddonFormPane's
 * useFormSaveController would otherwise drop its overlay on each
 * tab switch. Hidden panes still report state changes through
 * onPaneStateChange so the parent's pendingByTab dot stays accurate
 * regardless of which tab is active.
 */
interface TabbedAddonPanesProps {
  readonly entries: ReadonlyArray<
    AddonPaneEntry & { readonly renderedWithValues: ConfigUISchemaWithValues }
  >
  readonly paneStates: ReadonlyMap<string, AddonFormPaneState>
  readonly displayNames: ReadonlyMap<string, string>
  readonly disabled: boolean
  readonly setPaneRef: (addonId: string) => (handle: AddonFormPaneHandle | null) => void
  readonly onPaneStateChange: (state: AddonFormPaneState) => void
  readonly onImmediateSave: (addonId: string, patch: Record<string, unknown>) => void
  readonly onAction?: (
    addonId: string,
    action: string,
    key: string,
    value?: unknown,
  ) => Promise<unknown>
  /**
   * When true, render every pane stacked without the per-addon sub-tab
   * bar. Used when the parent already scoped the panel to a single
   * logical tab (via `sectionTab`) so all sections belong together and
   * splitting by addon adds noise instead of navigation value.
   */
  readonly inline?: boolean
}

function TabbedAddonPanes({
  entries,
  paneStates,
  displayNames,
  disabled,
  setPaneRef,
  onPaneStateChange,
  onImmediateSave,
  onAction,
  inline,
}: TabbedAddonPanesProps) {
  const sorted = useMemo(() => {
    return [...entries].toSorted((a, b) => {
      if (a.addonId === 'system-config') return -1
      if (b.addonId === 'system-config') return 1
      const an = displayNames.get(a.addonId) ?? a.addonId
      const bn = displayNames.get(b.addonId) ?? b.addonId
      return an.localeCompare(bn)
    })
  }, [entries, displayNames])

  const firstId = sorted[0]?.addonId ?? ''
  const [activeId, setActiveId] = useState<string>(firstId)

  // If the active tab disappears (addon uninstalled / filtered out)
  // snap to the first remaining pane so we never render an empty body.
  useEffect(() => {
    if (sorted.length === 0) return
    if (!sorted.find((p) => p.addonId === activeId)) {
      setActiveId(sorted[0]!.addonId)
    }
  }, [sorted, activeId])

  const active = sorted.find((p) => p.addonId === activeId) ?? sorted[0]
  if (!active) return null

  // Forward the optional 4th arg (resolved action input) so generic
  // addon-action-button / addon-action-select fields can ship their
  // resolved `paramsFromForm` payload to the parent dispatcher.
  // Memoised so leaf field effects (e.g. AddonActionSelectField's
  // option-loader useEffect) don't re-fire on every panel render.
  const wrappedAction = useMemo(
    () =>
      onAction
        ? (addonId: string, action: string, key: string, value?: unknown) =>
            onAction(addonId, action, key, value)
        : undefined,
    [onAction],
  )

  const renderPane = (entry: typeof active) => (
    <AddonFormPane
      key={entry.addonId}
      ref={setPaneRef(entry.addonId)}
      addonId={entry.addonId}
      schema={entry.renderedWithValues}
      serverValues={entry.serverValues}
      onImmediateSave={onImmediateSave}
      onStateChange={onPaneStateChange}
      onAction={wrappedAction}
      disabled={disabled}
    />
  )

  // Single pane OR inline mode: skip the addon-tab bar entirely. Inline
  // fires when the parent already scoped the panel to one logical tab
  // via `sectionTab` — splitting by addon inside a pre-filtered tab
  // just adds noise. Every pane stacks under the tab's root, with
  // section titles kept so related fields still group visually.
  if (sorted.length === 1 || inline) {
    return <div className="flex flex-col gap-4">{sorted.map(renderPane)}</div>
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1 border-b border-border shrink-0">
        {sorted.map((pane) => {
          const name = displayNames.get(pane.addonId) ?? pane.addonId
          const isActive = pane.addonId === active.addonId
          const dirty = (paneStates.get(pane.addonId)?.pendingKeys.length ?? 0) > 0
          return (
            <button
              key={pane.addonId}
              type="button"
              onClick={() => setActiveId(pane.addonId)}
              className={`relative px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors -mb-px border-b-2 whitespace-nowrap ${
                isActive
                  ? 'text-primary border-primary bg-primary/5'
                  : 'text-foreground-subtle border-transparent hover:text-foreground hover:bg-surface-hover'
              }`}
            >
              {name}
              {dirty && (
                <span className="ml-1.5 inline-flex h-1.5 w-1.5 rounded-full bg-amber-400" />
              )}
            </button>
          )
        })}
      </div>

      <div className="space-y-2">
        {/*
         * Mount every pane; hide inactive ones via display:none so
         * each pane's useFormSaveController overlay survives tab
         * switches. Without this, switching tabs would unmount the
         * inactive pane → controller resets pendingEdits → the
         * operator's typed-but-not-saved edits disappear silently.
         */}
        {sorted.map((pane) => (
          <div
            key={pane.addonId}
            style={pane.addonId === active.addonId ? undefined : { display: 'none' }}
          >
            {renderPane(pane)}
          </div>
        ))}
      </div>
    </div>
  )
}
