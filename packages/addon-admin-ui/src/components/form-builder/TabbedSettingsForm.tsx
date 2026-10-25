/**
 * TabbedSettingsForm — shared tabbed renderer for a `ConfigUISchemaWithValues`
 * that already went through a save-controller (values + pendingKeys +
 * onChange + onSave + onDiscard).
 *
 * Consolidates the logic previously inlined in DeviceAggregateSection's
 * `TabbedDeviceAggregate`:
 *   - Groups sections by `section.tab`
 *   - Single-tab schema falls back to a flat FormBuilder
 *   - Otherwise renders SchemaTabBar + per-tab FormBuilder + panel-level
 *     FormSaveBar that accumulates pending across every tab
 *
 * Callers keep ownership of the save orchestrator (useFormSaveController
 * or equivalent) and supply the values + mutations they want the form to
 * drive. This file is the render layer — no data fetching here.
 */
import { useMemo, useRef, useState } from 'react'
import type { ConfigSectionWithValues, ConfigUISchemaWithValues } from '../../types/config-ui'
import { FormBuilder } from './FormBuilder'
import { FormSaveBar } from './FormSaveBar'
import { SchemaTabBar } from './SchemaTabBar'
import { StableTabPanel } from '../StableTabPanel'

interface TabbedSettingsFormProps {
  readonly schema: ConfigUISchemaWithValues
  readonly values: Record<string, unknown>
  readonly pendingKeys: readonly string[]
  readonly onChange: (next: Record<string, unknown>) => void
  readonly onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
  readonly onSave: (keys: readonly string[]) => void
  readonly onDiscard: (keys: readonly string[]) => void
  readonly disabled: boolean
  /**
   * Optional controlled inner-tab id. When supplied the caller owns the
   * inner-tab selection (e.g. mirrored into a `?sub=` URL param by
   * DeviceDetail so a refresh restores the active sub-tab). When the id
   * is `null`/absent or names a tab that doesn't exist for this schema,
   * the form falls back to the first tab. Leaving both props unset keeps
   * the legacy internal-state behaviour.
   */
  readonly activeSubTab?: string | null
  readonly onSubTabChange?: (id: string) => void
  /**
   * When true, render every section in ONE flat list with no inner
   * sub-tab bar — even when the schema declares (or its sections span)
   * multiple `tab` ids. Used by the device-detail "Detection Pipeline"
   * top tab, which folds the former "Detection"/"Detection pipeline"
   * sub-tabs into a single flat surface. Sections keep the (tab, order)
   * sort applied upstream, so each tab's sections stay contiguous.
   */
  readonly flattenTabs?: boolean
  /**
   * Values of fields that live in a DIFFERENT tab of the same device form,
   * for `showWhen` only (see `FormBuilder.visibilityContext`).
   */
  readonly visibilityContext?: Record<string, unknown>
  /**
   * The device quick-detail modal draws one Save for every section. When
   * set, this form keeps the pending edits and does not draw its own bar.
   */
  readonly hideSaveBar?: boolean
}

export function TabbedSettingsForm({
  schema,
  values,
  pendingKeys,
  onChange,
  onAction,
  onSave,
  onDiscard,
  disabled,
  activeSubTab,
  onSubTabChange,
  flattenTabs = false,
  visibilityContext,
  hideSaveBar = false,
}: TabbedSettingsFormProps) {
  const tabs = schema.tabs ?? []

  const sectionsByTab = useMemo(() => {
    const groups = new Map<string, ConfigSectionWithValues[]>()
    for (const section of schema.sections) {
      const tabId = section.tab ?? 'general'
      const existing = groups.get(tabId) ?? []
      existing.push(section)
      groups.set(tabId, existing)
    }
    return groups
  }, [schema.sections])

  const declaredIds = new Set(tabs.map((t) => t.id))
  const orderedTabs = [
    ...tabs,
    ...[...sectionsByTab.keys()]
      .filter((id) => !declaredIds.has(id))
      // Ad-hoc tab ids without a declared label fall through to the raw
      // id — drivers must either reference a well-known tab id (whose
      // label comes from `WELL_KNOWN_TAB_MAP`) or declare their own via
      // `schema.tabs` in the addon contribution. We don't synthesise a
      // label from the id at render time; that produces awkward strings
      // for camelCase / kebab-case ids and silently masks missing
      // declarations.
      .map((id) => ({ id, label: id, icon: 'wrench', order: 100 })),
  ]

  const firstTabId = orderedTabs[0]?.id ?? 'general'
  // Internal fallback state — used only when the caller doesn't drive the
  // inner tab via `activeSubTab`/`onSubTabChange`.
  const [internalActiveTabId, setInternalActiveTabId] = useState<string>(firstTabId)
  const isControlled = onSubTabChange !== undefined
  // Effective active id. When controlled, prefer the caller's id but only
  // if it actually names a tab in this schema (async-discovered schemas can
  // briefly lack the requested tab); otherwise fall back to the first tab
  // WITHOUT mutating the caller's param — DeviceDetail decides when to
  // rewrite the URL.
  const orderedIds = new Set(orderedTabs.map((t) => t.id))
  // Every tab id this schema has EVER carried, for this mount.
  //
  // The schema is rebuilt on a 2.5 s poll from every contributing provider, so
  // a slow one drops its tab for a beat — the comment above already said so
  // ("async-discovered schemas can briefly lack the requested tab") and the
  // answer to "briefly" was to move the operator to another tab. The visible
  // effect is the reported one: the page snaps to a different, shorter tab and
  // leaves white space where the taller one was, right as the save banner
  // appears — because making a change is exactly what triggers the re-fetch.
  //
  // A tab that has existed once belongs to the operator until they leave it.
  // The fallback survives for the case it was written for: an id that has NEVER
  // been in this schema (a stale URL, a renamed tab) still resolves to the
  // first one, because that id is not blinking, it is wrong.
  const everSeenTabsRef = useRef<Set<string>>(new Set())
  for (const id of orderedIds) everSeenTabsRef.current.add(id)
  const everSeen = everSeenTabsRef.current

  const resolveActive = (requested: string | null | undefined): string => {
    if (!requested) return firstTabId
    if (orderedIds.has(requested)) return requested
    // Present once, missing now: hold. `activeSections` resolves to `[]` and
    // `StableTabPanel` keeps the height, so the panel goes quiet for a beat
    // instead of showing somewhere else.
    return everSeen.has(requested) ? requested : firstTabId
  }
  const activeTabId = isControlled
    ? resolveActive(activeSubTab)
    : resolveActive(internalActiveTabId)
  const handleSubTabChange = (id: string): void => {
    if (isControlled) onSubTabChange(id)
    else setInternalActiveTabId(id)
  }
  const activeSections = sectionsByTab.get(activeTabId) ?? []

  // Merge sections within a tab when all have empty titles — one unified
  // block reads better than N boxed containers with no visual distinction.
  const displaySections = (() => {
    if (activeSections.length <= 1) {
      return activeSections.length === 1 ? [{ ...activeSections[0]!, title: '' }] : activeSections
    }
    const allEmpty = activeSections.every((s) => !s.title)
    if (allEmpty) {
      return [
        {
          ...activeSections[0]!,
          title: '',
          fields: activeSections.flatMap((s) => s.fields),
        },
      ]
    }
    return activeSections
  })()
  const activeSchema: ConfigUISchemaWithValues = { sections: displaySections }

  const saveBar = hideSaveBar ? null : (
    <FormSaveBar
      pendingCount={pendingKeys.length}
      onSave={() => onSave(pendingKeys)}
      onDiscard={() => onDiscard(pendingKeys)}
      saving={disabled}
    />
  )

  if (flattenTabs || orderedTabs.length <= 1) {
    return (
      <div className="flex flex-col gap-3">
        <FormBuilder
          schema={schema}
          values={values}
          onChange={onChange}
          onAction={onAction}
          disabled={disabled}
          visibilityContext={visibilityContext}
        />
        {saveBar}
      </div>
    )
  }

  const countByTab = new Map<string, number>()
  const pendingByTab = new Map<string, number>()
  for (const [tabId, sections] of sectionsByTab) {
    countByTab.set(tabId, sections.length)
    const tabKeys = new Set<string>()
    const collectKeys = (
      fields: ReadonlyArray<ConfigSectionWithValues['fields'][number]>,
    ): void => {
      for (const f of fields) {
        if ('key' in f && typeof f.key === 'string') tabKeys.add(f.key)
        if (f.type === 'group') collectKeys(f.fields)
        else if (f.type === 'sub-tabs') {
          for (const subTab of f.tabs) collectKeys(subTab.fields)
        }
      }
    }
    for (const s of sections) collectKeys(s.fields)
    const pending = pendingKeys.filter((k) => tabKeys.has(k)).length
    if (pending > 0) pendingByTab.set(tabId, pending)
  }

  return (
    <div className="flex flex-col gap-3">
      <SchemaTabBar
        tabs={orderedTabs.map((t) => ({ id: t.id, label: t.label }))}
        activeId={activeTabId}
        onChange={handleSubTabChange}
        countByTab={countByTab}
        pendingByTab={pendingByTab}
      />
      {/* Only the active tab's sections are in the DOM, so switching tabs changes
          this panel's height — and on a phone, where container queries put every
          field on its own row, that delta is large enough to clamp the scroll
          container to the top. StableTabPanel holds the outgoing height until the
          new form has caught up. */}
      <StableTabPanel tabKey={activeTabId}>
        <FormBuilder
          schema={activeSchema}
          values={values}
          onChange={onChange}
          onAction={onAction}
          disabled={disabled}
          visibilityContext={visibilityContext}
        />
      </StableTabPanel>
      {saveBar}
    </div>
  )
}
