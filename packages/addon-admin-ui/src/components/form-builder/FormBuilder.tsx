import {
  ConfigFormField as FormField,
  DisclosureChevron,
  isFieldVisible,
  OptionSelect,
  type OptionSelectOption,
} from '@camstack/ui-library'
import type { NcSchedule } from '@camstack/types'
import { useState } from 'react'
import type {
  ConfigField,
  ConfigMultiSelectField,
  ConfigOption,
  ConfigSection,
  ConfigSectionWithValues,
  ConfigTagsField,
  ConfigUISchema,
  ConfigUISchemaWithValues,
  FieldProbeResult,
} from '../../types/config-ui'
import { ScheduleField } from '../../pages/system/notification-schedule-field'
import { shouldUseSearchableMultiSelect } from './searchable-multiselect-filter'
import type { ProbeState } from './useProbeAll'
import { useTranslation } from 'react-i18next'

function asNcSchedule(value: unknown): NcSchedule | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'object') return undefined
  const windows = Reflect.get(value, 'windows')
  if (!Array.isArray(windows) || windows.length === 0) return undefined
  return value as NcSchedule
}

function isMultiSelectField(field: ConfigField): field is ConfigMultiSelectField {
  return field.type === 'multiselect'
}

function tagsFieldOptions(field: ConfigTagsField): readonly OptionSelectOption[] {
  const suggestions = field.suggestions
  if (suggestions === undefined || suggestions.length === 0) return []
  return suggestions.map((s) => ({ value: s, label: s }))
}

function multiSelectOptions(options: readonly ConfigOption[]): readonly OptionSelectOption[] {
  return options.map((o) => ({
    value: o.value,
    label: o.label,
    ...(o.description !== undefined ? { description: o.description } : {}),
    ...(o.iconId !== undefined ? { iconId: o.iconId } : {}),
  }))
}

function selectedStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

// ---------------------------------------------------------------------------
// Field renderer with searchable-multiselect interception
// ---------------------------------------------------------------------------

/**
 * Renders one field. A `multiselect` with a large option set is swapped for
 * the searchable combobox (the flat chip toggle is unusable past a handful
 * of options); everything else delegates to the shared ui-library field.
 * Small multiselects keep the compact chip toggle.
 *
 * The searchable path re-implements the `showWhen` gate via the shared
 * `isFieldVisible` helper because it bypasses the ui-library `FormField`
 * (which normally applies it), so mode-conditional visibility is preserved.
 */
function FieldNode({
  field,
  values,
  onChange,
  onChangeMany,
  disabled,
  translationFn,
  onTestField,
  externalProbe,
  allFields,
  onAction,
}: {
  field: ConfigField
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  onChangeMany?: (patch: Record<string, unknown>) => void
  disabled?: boolean
  translationFn?: TranslationFn
  onTestField?: (key: string, value: unknown) => Promise<FieldProbeResult>
  externalProbe?: ProbeState
  allFields: readonly ConfigField[]
  onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
}) {
  const { t } = useTranslation()
  // Tags (catalog + free-form) share OptionSelect multi with creatable.
  if (field.type === 'tags') {
    if (!isFieldVisible(field, values, allFields)) return null
    const creatable = field.creatable !== false
    return (
      <OptionSelect
        mode="multi"
        options={tagsFieldOptions(field)}
        value={selectedStrings(values[field.key])}
        onChange={(v) => onChange(field.key, v)}
        disabled={disabled === true || field.disabled === true}
        creatable={creatable}
        {...(field.createLabel !== undefined ? { createLabel: field.createLabel } : {})}
        {...(field.maxTags !== undefined ? { maxItems: field.maxTags } : {})}
        label={resolveLabel(field.label, translationFn)}
        description={
          field.description !== undefined
            ? resolveLabel(field.description, translationFn)
            : undefined
        }
        placeholder={
          field.placeholder ?? t('formBuilder.formBuilder.searchOrAdd', 'Search or add…')
        }
        testId={`config-tags-${field.key}`}
      />
    )
  }
  // Same NcSchedule editor as Notification Center (`ScheduleField`).
  // `mode: 'times'` = punctual HH:MM; default `windows` = start→end bands.
  if (field.type === 'schedule') {
    if (!isFieldVisible(field, values, allFields)) return null
    const label = resolveLabel(field.label, translationFn)
    const description =
      field.description !== undefined ? resolveLabel(field.description, translationFn) : undefined
    const mode = field.mode === 'times' ? 'times' : 'windows'
    return (
      <div className="space-y-1" data-testid={`config-schedule-${field.key}`}>
        {label !== undefined && (
          <label className="block text-[11px] font-medium text-foreground-subtle">{label}</label>
        )}
        {description !== undefined && (
          <p className="text-[10px] text-foreground-subtle">{description}</p>
        )}
        <ScheduleField
          mode={mode}
          value={asNcSchedule(values[field.key])}
          onChange={(next) => onChange(field.key, next)}
        />
      </div>
    )
  }
  // Large multiselects (and creatable ones) use OptionSelect; small closed
  // catalogs keep the compact chip toggle in ConfigFormField.
  if (
    isMultiSelectField(field) &&
    (shouldUseSearchableMultiSelect(field.options.length) || field.creatable === true)
  ) {
    if (!isFieldVisible(field, values, allFields)) return null
    return (
      <OptionSelect
        mode="multi"
        options={multiSelectOptions(field.options)}
        value={selectedStrings(values[field.key])}
        onChange={(v) => onChange(field.key, v)}
        disabled={disabled === true || field.disabled === true}
        creatable={field.creatable === true}
        {...(field.createLabel !== undefined ? { createLabel: field.createLabel } : {})}
        {...(field.maxItems !== undefined ? { maxItems: field.maxItems } : {})}
        label={resolveLabel(field.label, translationFn)}
        description={
          field.description !== undefined
            ? resolveLabel(field.description, translationFn)
            : undefined
        }
        placeholder={
          field.placeholder ?? t('formBuilder.formBuilder.searchToAdd', 'Search to add…')
        }
        testId={`config-multiselect-${field.key}`}
        listboxId={`msel-${field.key}`}
      />
    )
  }
  return (
    <FormField
      field={field}
      values={values}
      onChange={onChange}
      onChangeMany={onChangeMany}
      disabled={disabled}
      translationFn={translationFn}
      onTestField={onTestField}
      externalProbe={externalProbe}
      allFields={allFields}
      onAction={onAction}
    />
  )
}

// ---------------------------------------------------------------------------
// Translation support
// ---------------------------------------------------------------------------

export type TranslationFn = (key: string) => string

function isI18nKey(value: string): boolean {
  return /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(value)
}

export function resolveLabel(value: string | undefined, t?: TranslationFn): string | undefined {
  if (value === undefined) return undefined
  if (t && isI18nKey(value)) return t(value)
  return value
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FormBuilderProps {
  schema: ConfigUISchema | ConfigUISchemaWithValues
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
  disabled?: boolean
  translationFn?: TranslationFn
  onTestField?: (key: string, value: unknown) => Promise<FieldProbeResult>
  /** External probe results from useProbeAll hook */
  probeResults?: Record<string, ProbeState>
  /** Callback to clear a probe result when a field value changes */
  onClearProbe?: (key: string) => void
  /** Callback for button actions */
  onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
  /**
   * Values owned by fields that are NOT in `schema` (another tab of the same
   * device form). Read by `showWhen` and by nothing else: they never reach
   * `onChange`, so they cannot become a pending edit. Without this a field
   * gated on a sibling-tab key (`motionSources` lives in Detection pipeline,
   * the analyzer knobs in Config -> Motion) is hidden forever, because an
   * absent key reads as "not selected".
   */
  visibilityContext?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Section renderer
// ---------------------------------------------------------------------------

function SectionCard({
  section,
  values,
  onChange,
  onChangeMany,
  disabled,
  translationFn,
  onTestField,
  probeResults,
  onAction,
}: {
  section: ConfigSection | ConfigSectionWithValues
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  onChangeMany?: (patch: Record<string, unknown>) => void
  disabled?: boolean
  translationFn?: TranslationFn
  onTestField?: (key: string, value: unknown) => Promise<FieldProbeResult>
  probeResults?: Record<string, ProbeState>
  onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
}) {
  const [collapsed, setCollapsed] = useState(section.defaultCollapsed ?? false)
  const isAccordion = section.style === 'accordion'

  // Pre-evaluate showWhen across every field in the section so a section
  // whose entire content is gated out (e.g. motion-wasm tuning when
  // `analyzer` isn't in `motionSources`) collapses entirely instead of
  // rendering an empty card with just the header. Structural fields
  // (separator/info/button) carry no showWhen so they never participate
  // in the gate; if a section contains ONLY structural fields, those
  // still render. Multiple-mode fields and group/sub-tabs containers are
  // treated as visible by the shared helper because their visibility is
  // delegated to inner fields at render time.
  const visibleFieldCount = section.fields.reduce(
    (n: number, field: ConfigField | ConfigSectionWithValues['fields'][number]) => {
      return (
        n +
        (isFieldVisible(field as ConfigField, values, section.fields as readonly ConfigField[])
          ? 1
          : 0)
      )
    },
    0,
  )
  if (visibleFieldCount === 0) return null

  // Container-query responsive grid: one field per row below ~480px, multi-col
  // above. The column count adapts to the SECTION width (inline container-type
  // below), not the viewport — vital in narrow device-detail panels. CRITICAL:
  // the per-field col-span (FieldWrapper) is responsive at the SAME @[480px]
  // threshold, so below it every field is col-span-1. A raw col-span-2 in a
  // 1-col grid forces an implicit auto column that siblings collapse into (the
  // hik "Mode sliver / Brightness regulator wide" bug) — keeping span and grid
  // in lockstep avoids it.
  const renderFields = section.fields
  const columns = section.columns ?? 2
  const gridClass =
    columns === 1
      ? 'grid-cols-1'
      : columns === 3
        ? 'grid-cols-1 @[480px]:grid-cols-2 @[880px]:grid-cols-3'
        : columns === 4
          ? 'grid-cols-1 @[480px]:grid-cols-2 @[1140px]:grid-cols-4'
          : 'grid-cols-1 @[480px]:grid-cols-2'

  // A section whose entire content is a SINGLE `type:'widget'` field is
  // a full-bleed widget mount (PTZ / Motion Zones / Detection Zones /
  // Autotrack / live-stats). The widget component renders its OWN
  // internal header, so the section-card title/description chrome would
  // be a redundant second (or third) title. Treat it as chromeless —
  // keep the card container for consistent padding/border, drop the
  // header text.
  const singleWidgetField =
    section.fields.length === 1 && section.fields[0]?.type === 'widget'
      ? section.fields[0]
      : undefined
  const isSingleWidgetSection = singleWidgetField !== undefined

  // Empty title → treat the section as "chromeless": drop the header
  // row entirely so the caller (e.g. DeviceAggregateSection) can hide
  // the section title when it's redundant with the parent tab label.
  const hideHeader = isSingleWidgetSection || (!section.title && !section.description)

  return (
    <div
      className="@container rounded-lg border border-border bg-surface p-3"
      style={{ containerType: 'inline-size' }}
      data-settings-section={section.id}
    >
      {!hideHeader &&
        (isAccordion ? (
          <button // ui-check-ok: full-width disclosure header row; Button chrome breaks the section strip
            type="button"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
            className="flex w-full items-center justify-between mb-2 text-left"
          >
            <div>
              {section.title && (
                <h3 className="text-[11px] font-semibold text-foreground-subtle uppercase tracking-wider">
                  {resolveLabel(section.title, translationFn)}
                </h3>
              )}
              {section.description && (
                <p className="text-[10px] text-foreground-subtle mt-0.5">
                  {resolveLabel(section.description, translationFn)}
                </p>
              )}
            </div>
            <DisclosureChevron expanded={!collapsed} className="ml-2" />
          </button>
        ) : (
          <div className="flex items-center justify-between mb-2">
            <div>
              {section.title && (
                <h3 className="text-[11px] font-semibold text-foreground-subtle uppercase tracking-wider">
                  {resolveLabel(section.title, translationFn)}
                </h3>
              )}
              {section.description && (
                <p className="text-[10px] text-foreground-subtle mt-0.5">
                  {resolveLabel(section.description, translationFn)}
                </p>
              )}
            </div>
          </div>
        ))}

      {/* A header-less accordion has nothing to click open: never seal it. */}
      {!(collapsed && !hideHeader) &&
        (singleWidgetField !== undefined ? (
          <FormField
            key={singleWidgetField.key}
            field={singleWidgetField}
            values={values}
            onChange={onChange}
            onChangeMany={onChangeMany}
            disabled={disabled}
            translationFn={translationFn}
            onTestField={onTestField}
            externalProbe={probeResults?.[singleWidgetField.key]}
            allFields={section.fields}
            onAction={onAction}
          />
        ) : (
          <>
            <div className={`grid ${gridClass} gap-x-3 gap-y-2.5`}>
              {renderFields.map((field) => (
                <FieldNode
                  key={field.key}
                  field={field}
                  values={values}
                  onChange={onChange}
                  onChangeMany={onChangeMany}
                  disabled={disabled}
                  translationFn={translationFn}
                  onTestField={onTestField}
                  externalProbe={probeResults?.[field.key]}
                  allFields={section.fields}
                  onAction={onAction}
                />
              ))}
            </div>
          </>
        ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// FormBuilder
// ---------------------------------------------------------------------------

export function FormBuilder({
  schema,
  values,
  onChange,
  disabled,
  translationFn,
  onTestField,
  probeResults,
  onClearProbe,
  onAction,
  visibilityContext,
}: FormBuilderProps) {
  // The form's own values win over the context: a key present in both is the
  // form's own field, edited here.
  const renderedValues = visibilityContext ? { ...visibilityContext, ...values } : values
  const handleFieldChange = (key: string, value: unknown) => {
    onChange({ ...values, [key]: value })
    onClearProbe?.(key)
  }
  const handleFieldsChange = (patch: Record<string, unknown>) => {
    onChange({ ...values, ...patch })
    for (const key of Object.keys(patch)) {
      onClearProbe?.(key)
    }
  }

  return (
    <div className="space-y-4">
      {schema.sections.map((section, index) => (
        <SectionCard
          // Compose `id + index` so the key stays stable across renders
          // AND tolerates multiple contributors emitting the same
          // section.id (the aggregator doesn't namespace ids, and two
          // addons may legitimately name their section the same thing).
          key={`${section.id}-${index}`}
          section={section}
          values={renderedValues}
          onChange={handleFieldChange}
          onChangeMany={handleFieldsChange}
          disabled={disabled}
          translationFn={translationFn}
          onTestField={onTestField}
          probeResults={probeResults}
          onAction={onAction}
        />
      ))}
    </div>
  )
}
