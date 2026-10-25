import { useState, type JSX } from 'react'
import type { ConfigUISchema, ConfigSection, FieldProbeResult } from '@camstack/types'
import { ConfigFormField } from './config-form-field'
import type { ProbeState } from './config-form-field'

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
  schema: ConfigUISchema
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
  disabled?: boolean
  translationFn?: TranslationFn
  onTestField?: (key: string, value: unknown) => Promise<FieldProbeResult>
  /** External probe results from useProbeAll hook */
  probeResults?: Record<string, ProbeState>
  /** Callback to clear a probe result when a field value changes */
  onClearProbe?: (key: string) => void
  /**
   * Fields only — no section border, title or description. For a parent that
   * already frames the form (or wants a single field with no chrome).
   */
  bare?: boolean
}

// ---------------------------------------------------------------------------
// Section grid (shared by SectionCard and bare mode)
// ---------------------------------------------------------------------------

/**
 * Container-query driven responsive grid. Each section is its own
 * `@container` so the column count adapts to the SECTION's width
 * (not the viewport) — important inside narrow hosts like the
 * device-detail right column / ItemFormDialog. Behavior:
 *   columns=1            → always 1 col
 *   columns=2 (default)  → 1 col below 480px container, 2 cols above
 *   columns=3            → 1 → 2 → 3 col at 480px / 880px
 *   columns=4            → 1 → 2 → 4 col at 480px / 1140px
 */
export function sectionGridClass(columns: 1 | 2 | 3 | 4 | undefined): string {
  const cols = columns ?? 2
  // i18n-ignore-start: Tailwind class lists
  if (cols === 1) return 'grid-cols-1'
  if (cols === 3) return 'grid-cols-1 @[480px]:grid-cols-2 @[880px]:grid-cols-3'
  if (cols === 4) return 'grid-cols-1 @[480px]:grid-cols-2 @[1140px]:grid-cols-4'
  return 'grid-cols-1 @[480px]:grid-cols-2'
  // i18n-ignore-end
}

// ---------------------------------------------------------------------------
// Section renderer
// ---------------------------------------------------------------------------

function SectionCard({
  section,
  values,
  onChange,
  disabled,
  translationFn,
  onTestField,
  probeResults,
}: {
  section: ConfigSection
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
  onTestField?: (key: string, value: unknown) => Promise<FieldProbeResult>
  probeResults?: Record<string, ProbeState>
}) {
  const [collapsed, setCollapsed] = useState(section.defaultCollapsed ?? false)
  const isAccordion = section.style === 'accordion'

  // Container-query driven responsive grid — see sectionGridClass().
  const gridClass = sectionGridClass(section.columns)

  return (
    <div
      className="@container rounded-lg border border-border bg-surface p-3"
      style={{ containerType: 'inline-size' }}
    >
      <div
        className={[
          'flex items-center justify-between mb-2',
          isAccordion ? 'cursor-pointer' : '',
        ].join(' ')}
        onClick={isAccordion ? () => setCollapsed((c) => !c) : undefined}
      >
        <div>
          <h3 className="text-[11px] font-semibold text-foreground-subtle uppercase tracking-wider">
            {resolveLabel(section.title, translationFn)}
          </h3>
          {section.description && (
            <p className="text-[10px] text-foreground-subtle mt-0.5">
              {resolveLabel(section.description, translationFn)}
            </p>
          )}
        </div>
        {isAccordion && (
          <span className="text-foreground-subtle text-xs ml-2">{collapsed ? '▸' : '▾'}</span>
        )}
      </div>

      {!collapsed && (
        <div className={`grid ${gridClass} gap-x-3 gap-y-2.5`}>
          {section.fields.map((field) => (
            <ConfigFormField
              key={field.key}
              field={field}
              values={values}
              onChange={onChange}
              disabled={disabled}
              translationFn={translationFn}
              onTestField={onTestField}
              externalProbe={probeResults?.[field.key]}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// FormBuilder
// ---------------------------------------------------------------------------

export function ConfigFormBuilder({
  schema,
  values,
  onChange,
  disabled,
  translationFn,
  onTestField,
  probeResults,
  onClearProbe,
  bare = false,
}: FormBuilderProps): JSX.Element {
  const handleFieldChange = (key: string, value: unknown) => {
    onChange({ ...values, [key]: value })
    onClearProbe?.(key)
  }

  if (bare) {
    // Honor section.columns (same grids as SectionCard) — still no
    // title/border chrome. Flattening to grid-cols-1 hid multi-col
    // schemas inside ItemFormDialog (OIDC, Training Providers, …).
    return (
      <div className="space-y-4">
        {schema.sections.map((section) => (
          <div key={section.id} className="@container" style={{ containerType: 'inline-size' }}>
            <div className={`grid ${sectionGridClass(section.columns)} gap-x-3 gap-y-2.5`}>
              {section.fields.map((field) => (
                <ConfigFormField
                  key={field.key}
                  field={field}
                  values={values}
                  onChange={handleFieldChange}
                  disabled={disabled}
                  translationFn={translationFn}
                  onTestField={onTestField}
                  externalProbe={probeResults?.[field.key]}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {schema.sections.map((section) => (
        <SectionCard
          key={section.id}
          section={section}
          values={values}
          onChange={handleFieldChange}
          disabled={disabled}
          translationFn={translationFn}
          onTestField={onTestField}
          probeResults={probeResults}
        />
      ))}
    </div>
  )
}
