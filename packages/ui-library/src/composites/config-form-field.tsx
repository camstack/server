import { useState, useCallback, useRef, useEffect, type JSX } from 'react'
import {
  Wifi,
  Loader2,
  CheckCircle,
  AlertCircle,
  Copy,
  RefreshCw,
  ExternalLink,
  Trash2,
  Download,
  Upload,
  Wrench,
  Plus,
  Minus,
} from 'lucide-react'
import type {
  ConfigField,
  ConfigGroupField,
  ConfigSubTabsField,
  ConfigInfoField,
  ConfigQrCodeField,
  ConfigObjectArrayField,
  ConfigEditableArrayField,
  ConfigMultiSelectField,
  ConfigNumberField,
  ConfigBooleanField,
  ConfigSelectField,
  ConfigTimezoneField,
  ConfigDateTimeField,
  ConfigColorField,
  ConfigIconField,
  ConfigTextAreaField,
  ConfigSliderField,
  ConfigTagsField,
  ConfigPasswordField,
  ConfigTextField,
  ConfigProbeField,
  ConfigButtonField,
  ConfigNodeSelectField,
  ConfigNodeMultiSelectField,
  ConfigDeviceSelectField,
  ConfigDeviceMultiSelectField,
  ConfigNotificationTargetSelectField,
  ConfigNotificationTargetMultiSelectField,
  ConfigWidgetField,
  ConfigAddonActionSelectField,
  ConfigAddonActionButtonField,
  ConfigDeviceActionButtonField,
  FieldInlineAction,
  FieldProbeResult,
} from '@camstack/types'
import { isKeychainStoredField, isSecretClear, isSecretFieldView } from '@camstack/types'
import { useClusterNodes as useClusterNodesHook } from '../hooks/use-cluster-nodes'
import { ConfigIconFieldControl } from './config-icon-field'
import { sanitizeInfoHtml } from './sanitize-info-html.js'
import { PasswordInput } from '../primitives/password-input'
import { Select } from '../primitives/select'
import { isKeychainFieldValue, SecretFieldControl } from './config-secret-field'
import { DeviceSelectField, DeviceMultiSelectField } from './device-select-field'
import {
  ConfigNotificationTargetMultiSelectFieldView,
  ConfigNotificationTargetSelectFieldView,
} from './notification-targets-field'
import type { TranslationFn } from './config-form-builder'
import { resolveLabel } from './config-form-builder'
import { useCustomFieldRenderer } from '../contexts/custom-field-renderers'
import { useUiText } from '../contexts/ui-text'
import { EventKindGlyph } from './event-kind-visuals'
import { AccountSignInField, SecretPresenceField } from './account-sign-in-field'
import { useConfirm, usePrompt } from './confirm-dialog'
import { useDeviceId } from '../contexts/device-context'
import { WidgetSlot } from './widget-slot'
import { QrCode } from './qr-code'
import { TimezoneSelector } from './timezone-selector'
import { OptionSelect, type OptionSelectOption } from './option-select'

/** Probe state for a single field — exported for callers that need to track probe lifecycle externally. */
export interface ProbeState {
  status: 'probing' | 'ok' | 'error'
  result?: FieldProbeResult
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FormFieldProps {
  field: ConfigField
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  /** Apply several form keys in one update (e.g. addon-action-button assignResult). */
  onChangeMany?: (patch: Record<string, unknown>) => void
  disabled?: boolean
  translationFn?: TranslationFn
  /**
   * Dedicated probe callback — used by the device-creation dialog where
   * the device doesn't exist yet so the generic `onAction` routing
   * cannot resolve an addon owner. For existing-device forms prefer
   * `onAction` with action `'test-probe'`: the probe field falls back
   * to it when `onTestField` is absent, so the two paths converge.
   */
  onTestField?: (key: string, value: unknown) => Promise<FieldProbeResult>
  /** External probe result (from "Test All" button) */
  externalProbe?: { status: 'probing' | 'ok' | 'error'; result?: FieldProbeResult }
  /**
   * Inline-action callback. Fired by icon buttons on any field
   * (copy-value, regenerate-rtsp-token, …) and by the probe field's
   * Test button when `onTestField` is not provided — in that case the
   * action name is `'test-probe'` and the current field value flows
   * through the third arg so the handler can probe it.
   *
   * Returns `Promise<unknown>` (not `void`) because some actions yield
   * a result the caller wants (the probe returns a `FieldProbeResult`).
   */
  onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
  /** All fields in the section — used to resolve defaults for showWhen conditions */
  allFields?: readonly ConfigField[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INPUT_CLASS =
  'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none disabled:opacity-50 disabled:cursor-not-allowed'

const LABEL_CLASS = 'block text-[11px] font-medium text-foreground mb-1 break-words'
const DESC_CLASS = 'text-[10px] text-foreground-subtle mt-0.5 break-words'

function FieldWrapper({
  label,
  description,
  required,
  span,
  htmlFor,
  children,
  translationFn,
}: {
  label?: string
  description?: string
  required?: boolean
  span?: number
  /** Associates the visible label with a control id (a11y + getByLabelText). */
  htmlFor?: string
  children: React.ReactNode
  translationFn?: TranslationFn
}) {
  // Span is RESPONSIVE and must track the section grid's column count. Below
  // the grid's 2-col threshold the grid is a single column, and a raw
  // `col-span-2`/`col-span-3` there forces an implicit auto-sized extra column
  // that sibling fields collapse into. So spans stay `col-span-1` until the
  // same `@[480px]` container width where the grid itself goes multi-column.
  const colSpanClass =
    span === 2
      ? 'col-span-1 @[480px]:col-span-2'
      : span === 3
        ? 'col-span-1 @[480px]:col-span-2 @[880px]:col-span-3'
        : span === 4
          ? 'col-span-1 @[480px]:col-span-2 @[1140px]:col-span-4'
          : 'col-span-1'

  const resolvedLabel = resolveLabel(label, translationFn)
  const resolvedDescription = resolveLabel(description, translationFn)

  // Treat empty-string labels as "no label" so the `<label>` element
  // doesn't occupy a header row that would push the input down (which
  // breaks alignment with sibling controls — notably the trailing
  // delete button on `multiple`-field rows, which needs to sit next
  // to the input, not its empty header).
  const hasLabel = resolvedLabel !== undefined && resolvedLabel !== ''
  return (
    // `min-w-0` is required: this div is a grid item in the section's
    // `grid-cols-2` layout. Without it the item keeps its default
    // `min-width: auto` (= content min-content), so a wide control or
    // a long unbreakable label overflows its `1fr` track — overlapping
    // the sibling column and starving it to a one-word-per-line sliver.
    <div className={`${colSpanClass} min-w-0`}>
      {hasLabel && (
        <label className={LABEL_CLASS} {...(htmlFor !== undefined ? { htmlFor } : {})}>
          {resolvedLabel}
          {required && <span className="text-danger ml-0.5">*</span>}
        </label>
      )}
      {children}
      {resolvedDescription && <p className={DESC_CLASS}>{resolvedDescription}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Field renderers
// ---------------------------------------------------------------------------

/**
 * A keychain-stored secret (D787) arrives as its VIEW — `{ $secret, set }` —
 * or `null`, never as a value; it renders as one password input with an eye.
 * Decided ONCE, at mount, from what the form was hydrated with: once the
 * operator types, the value is a plain string and the field must stay the
 * same control. A form that was not hydrated from a keychain-aware store (a
 * create dialog seeding `''`) keeps the plain input.
 */
function KeychainOr({
  field,
  value,
  onChange,
  disabled,
  translationFn,
  multiline,
  children,
}: {
  field: ConfigField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
  multiline?: boolean
  children: React.ReactNode
}) {
  const isKeychain = isKeychainStoredField(field)
  const [keychain, setKeychain] = useState(() => isKeychain && isKeychainFieldValue(value))
  // The latch only goes one way. A field mounted empty (a form opened before
  // anything was stored) that is later handed the stored VIEW — the operator
  // typed, saved, and the form refetched — becomes the keychain control; left
  // as a plain input it would print the view object as its text.
  const hydrated = isKeychain && isSecretFieldView(value)
  if (hydrated && !keychain) setKeychain(true)
  if (!keychain && !hydrated) return <>{children}</>
  return (
    <FieldWrapper
      label={'label' in field ? field.label : undefined}
      description={'description' in field ? field.description : undefined}
      required={'required' in field ? field.required : undefined}
      span={'span' in field ? field.span : undefined}
      translationFn={translationFn}
    >
      <SecretFieldControl
        field={field}
        value={value}
        onChange={onChange}
        disabled={disabled}
        multiline={multiline}
      />
    </FieldWrapper>
  )
}

function TextField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigTextField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}) {
  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
      translationFn={translationFn}
    >
      <input
        type={field.inputType ?? 'text'}
        className={INPUT_CLASS}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={field.placeholder}
        maxLength={field.maxLength}
        pattern={field.pattern}
        disabled={disabled || field.disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldWrapper>
  )
}

function NumberField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigNumberField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}) {
  // Local string state preserves mid-typing states (e.g. empty string, "-", "0.")
  // that a numeric parse would discard. Upstream value only syncs back when the
  // prop changes externally (initial load, programmatic reset) — not while the
  // field is focused, so a user's empty input isn't auto-filled with 0.
  const [local, setLocal] = useState<string>(
    value === undefined || value === null ? '' : String(value),
  )
  const focusedRef = useRef(false)

  useEffect(() => {
    if (focusedRef.current) return
    const next = value === undefined || value === null ? '' : String(value)
    setLocal(next)
  }, [value])

  const handleChange = (raw: string): void => {
    setLocal(raw)
    if (raw === '' || raw === '-') {
      onChange(undefined)
      return
    }
    const parsed = Number(raw)
    if (Number.isNaN(parsed)) return
    onChange(parsed)
  }

  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
      translationFn={translationFn}
    >
      <div className="flex items-center gap-1">
        <input
          type="number"
          className={INPUT_CLASS}
          value={local}
          placeholder={field.placeholder}
          min={field.min}
          max={field.max}
          step={field.step}
          disabled={disabled || field.disabled}
          onFocus={() => {
            focusedRef.current = true
          }}
          onBlur={() => {
            focusedRef.current = false
          }}
          onChange={(e) => handleChange(e.target.value)}
        />
        {field.unit && (
          <span className="text-xs text-foreground-subtle whitespace-nowrap">{field.unit}</span>
        )}
      </div>
    </FieldWrapper>
  )
}

function BooleanField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigBooleanField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}) {
  const checked = Boolean(value)
  const isDisabled = disabled || field.disabled

  if (field.style === 'checkbox') {
    return (
      <FieldWrapper
        label={undefined}
        description={field.description}
        required={field.required}
        span={field.span}
        translationFn={translationFn}
      >
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded border-border accent-primary"
            checked={checked}
            disabled={isDisabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="text-xs font-medium text-foreground">
            {resolveLabel(field.label, translationFn)}
          </span>
          {field.required && <span className="text-danger">*</span>}
        </label>
      </FieldWrapper>
    )
  }

  // Default: toggle switch
  return (
    <FieldWrapper
      label={undefined}
      description={field.description}
      required={field.required}
      span={field.span}
      translationFn={translationFn}
    >
      <div className="flex items-center justify-between">
        <span className={LABEL_CLASS + ' mb-0'}>
          {resolveLabel(field.label, translationFn)}
          {field.required && <span className="text-danger ml-0.5">*</span>}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          disabled={isDisabled}
          onClick={() => !isDisabled && onChange(!checked)}
          className={[
            'relative inline-flex h-4 w-8 shrink-0 items-center rounded-full transition-colors duration-150',
            checked ? 'bg-primary' : 'bg-foreground-subtle/30',
            isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
          ].join(' ')}
        >
          <span
            className={[
              'inline-block h-3 w-3 rounded-full bg-white shadow transition-transform duration-150',
              checked ? 'translate-x-4' : 'translate-x-0.5',
            ].join(' ')}
          />
        </button>
      </div>
    </FieldWrapper>
  )
}

function SelectField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigSelectField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}) {
  const t = useUiText()
  // Only prepend the placeholder when the schema's own options don't already
  // define a value="" entry. Otherwise two options share the same value and
  // the DOM picks the placeholder over the schema's semantic option (e.g.
  // "Auto (matches backend)").
  const hasEmptyOption = field.options.some((o) => o.value === '')
  const options = [
    ...(!field.required && !hasEmptyOption
      ? [{ value: '', label: t('uiLibrary.configFormField.select', '— Select —') }]
      : []),
    ...field.options.map((opt) => ({ value: opt.value, label: opt.label })),
  ]
  const controlId = `config-select-${field.key}`
  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
      htmlFor={controlId}
      translationFn={translationFn}
    >
      <Select
        id={controlId}
        options={options}
        value={value === undefined || value === null ? '' : String(value)}
        disabled={disabled || field.disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldWrapper>
  )
}

function TimezoneField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigTimezoneField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}) {
  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
      translationFn={translationFn}
    >
      <TimezoneSelector
        value={typeof value === 'string' ? value : ''}
        onChange={onChange}
        disabled={disabled || field.disabled}
      />
    </FieldWrapper>
  )
}

function DateTimeField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigDateTimeField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}) {
  // `datetime-local` value is `YYYY-MM-DDTHH:MM` (local wall-clock, no
  // seconds / zone). We store the raw string the input emits verbatim.
  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
      translationFn={translationFn}
    >
      <input
        type="datetime-local"
        className={INPUT_CLASS}
        value={typeof value === 'string' ? value : ''}
        placeholder={field.placeholder}
        disabled={disabled || field.disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldWrapper>
  )
}

function MultiSelectField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigMultiSelectField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}) {
  const selected = Array.isArray(value) ? (value as string[]) : []

  const toggle = (optValue: string) => {
    if (selected.includes(optValue)) {
      onChange(selected.filter((v) => v !== optValue))
    } else {
      if (field.maxItems !== undefined && selected.length >= field.maxItems) return
      onChange([...selected, optValue])
    }
  }

  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
      translationFn={translationFn}
    >
      <div className="flex flex-wrap gap-2">
        {field.options.map((opt) => {
          const checked = selected.includes(opt.value)
          return (
            <label
              key={opt.value}
              className={[
                'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-pointer select-none transition-colors',
                checked
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-foreground hover:bg-surface',
                disabled || field.disabled ? 'opacity-50 cursor-not-allowed' : '',
              ].join(' ')}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={checked}
                disabled={disabled || field.disabled}
                onChange={() => toggle(opt.value)}
              />
              {/* Shared taxonomy glyph when the option names one — see
                  `ConfigOption.iconId`. No `iconId` ⇒ plain text, unchanged. */}
              {opt.iconId !== undefined && <EventKindGlyph iconId={opt.iconId} size={13} />}
              {opt.label}
            </label>
          )
        })}
      </div>
    </FieldWrapper>
  )
}

function PasswordField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigPasswordField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}) {
  const [show, setShow] = useState(false)
  const text = value === undefined || value === null ? '' : String(value)

  // A plaintext value (a camera driver's form, a create dialog): the same
  // one-input control as a keychain secret, whose eye only shows what is there.
  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
      translationFn={translationFn}
    >
      <PasswordInput
        aria-label={field.label}
        value={text}
        onValueChange={(next) => onChange(next)}
        shown={show}
        onToggleShown={() => setShow((s) => !s)}
        hideToggle={field.showToggle === false}
        placeholder={field.placeholder}
        disabled={disabled || field.disabled}
        onFocus={(e) => {
          // A stand-in mask (••••) is selected so the first keystroke replaces
          // it; the eye toggle still reveals the filled field beforehand.
          if (text.length > 0 && /^[•●*]{4,}$/u.test(text)) {
            e.currentTarget.select()
          }
        }}
      />
    </FieldWrapper>
  )
}

function TextAreaField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigTextAreaField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}) {
  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
      translationFn={translationFn}
    >
      <textarea
        className={INPUT_CLASS + ' resize-y min-h-[60px]'}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={field.placeholder}
        rows={field.rows ?? 3}
        maxLength={field.maxLength}
        disabled={disabled || field.disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldWrapper>
  )
}

function SliderField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigSliderField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}) {
  const t = useUiText()
  const isNull = value === undefined || value === null
  const isNullable = field.nullable === true
  const numVal = isNull ? (field.default ?? field.min) : Number(value)
  const showValue = field.showValue !== false
  const nullLabel = field.nullLabel ?? t('uiLibrary.configFormField.auto', 'Auto')
  const isDisabled = disabled || field.disabled
  const scale = field.displayScale ?? 1
  // Display values: convert stored value for UI (e.g., 10000ms → 10s)
  const displayMin = field.min / scale
  const displayMax = field.max / scale
  const displayVal = numVal / scale
  const displayStep = (field.step ?? 1) / scale

  // When nullable and value is null, show "Auto" toggle state
  if (isNullable && isNull) {
    return (
      <FieldWrapper
        label={field.label}
        description={field.description}
        required={field.required}
        span={field.span}
        translationFn={translationFn}
      >
        <button
          className="w-full rounded-lg border border-dashed border-border px-3 py-2 text-xs text-foreground-subtle hover:border-primary/40 hover:text-primary transition-colors text-left"
          disabled={isDisabled}
          onClick={() => onChange(field.default ?? field.min)}
        >
          {t('uiLibrary.configFormField.clickToSet', '{{label}} — click to set manually', {
            label: nullLabel,
          })}
        </button>
      </FieldWrapper>
    )
  }

  const stepperEnabled = field.showStepper === true && showValue
  const bumpBy = (deltaUnits: number): void => {
    // Step is in display units; multiply by `scale` to recover stored value.
    const next = numVal + deltaUnits * (field.step ?? 1)
    const clamped = Math.min(field.max, Math.max(field.min, next))
    if (clamped === numVal) return
    onChange(clamped)
  }
  const stepperBtnClass =
    'flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border bg-surface text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:cursor-not-allowed disabled:opacity-40'

  // Two responsive sub-rows: the slider track (with min/max bookends)
  // and the value controls (steppers + number input + unit + nullable
  // reset). The outer flex wraps when the container is too narrow for
  // both groups on one line — typical when the form uses `columns: 2`
  // in a split-view panel. Each sub-row is `flex-shrink-0` so its own
  // contents stay together; only the inter-group break wraps.
  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
      translationFn={translationFn}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-[160px] items-center gap-2">
          <span className="text-[10px] text-foreground-subtle tabular-nums shrink-0">
            {displayMin}
          </span>
          <input
            type="range"
            className="min-w-0 flex-1 h-1 accent-primary cursor-pointer disabled:opacity-50"
            min={displayMin}
            max={displayMax}
            step={displayStep}
            value={displayVal}
            disabled={isDisabled}
            onChange={(e) => onChange(Number(e.target.value) * scale)}
          />
          <span className="text-[10px] text-foreground-subtle tabular-nums shrink-0">
            {displayMax}
          </span>
        </div>
        {(showValue || isNullable || field.unit) && (
          <div className="flex shrink-0 items-center gap-2">
            {stepperEnabled && (
              <button
                type="button"
                className={stepperBtnClass}
                disabled={isDisabled || numVal <= field.min}
                onClick={() => bumpBy(-1)}
                title={t('uiLibrary.configFormField.decreaseBy', 'Decrease by {{step}}', {
                  step: field.step ?? 1,
                })}
                aria-label={t('uiLibrary.configFormField.decrement', 'Decrement')}
              >
                <Minus className="h-3 w-3" />
              </button>
            )}
            {showValue && (
              <input
                type="number"
                className="w-16 rounded border border-border bg-surface px-1.5 py-0.5 text-xs text-center text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
                min={displayMin}
                max={displayMax}
                step={displayStep}
                value={displayVal}
                disabled={isDisabled}
                onChange={(e) => {
                  if (e.target.value === '') {
                    onChange(isNullable ? null : field.min)
                    return
                  }
                  const raw = Number(e.target.value) * scale
                  // Snap to the closest valid step so the discrete-grid contract
                  // declared by `step` holds end-to-end (range thumb already
                  // snaps natively; the number input would otherwise accept
                  // arbitrary values like `25` when step=20).
                  const stepUnits = field.step ?? 1
                  const offset = raw - field.min
                  const snapped = field.min + Math.round(offset / stepUnits) * stepUnits
                  onChange(Math.min(field.max, Math.max(field.min, snapped)))
                }}
              />
            )}
            {stepperEnabled && (
              <button
                type="button"
                className={stepperBtnClass}
                disabled={isDisabled || numVal >= field.max}
                onClick={() => bumpBy(1)}
                title={t('uiLibrary.configFormField.increaseBy', 'Increase by {{step}}', {
                  step: field.step ?? 1,
                })}
                aria-label={t('uiLibrary.configFormField.increment', 'Increment')}
              >
                <Plus className="h-3 w-3" />
              </button>
            )}
            {field.unit && <span className="text-[10px] text-foreground-subtle">{field.unit}</span>}
            {isNullable && (
              <button
                className="text-[10px] text-foreground-subtle hover:text-primary transition-colors"
                title={t('uiLibrary.configFormField.resetTo', 'Reset to {{label}}', {
                  label: nullLabel,
                })}
                disabled={isDisabled}
                onClick={() => onChange(null)}
              >
                {nullLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </FieldWrapper>
  )
}

function TagsField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigTagsField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}) {
  const t = useUiText()
  // Catalog + free-form via OptionSelect (same control as admin FormBuilder).
  const tags = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  const creatable = field.creatable !== false
  const suggestions = field.suggestions ?? []
  const options: readonly OptionSelectOption[] = suggestions.map((s) => ({
    value: s,
    label: s,
  }))
  const isDisabled = disabled === true || field.disabled === true

  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
      translationFn={translationFn}
    >
      <OptionSelect
        mode="multi"
        options={options}
        value={tags}
        onChange={(next) => onChange(next)}
        disabled={isDisabled}
        creatable={creatable}
        {...(field.createLabel !== undefined ? { createLabel: field.createLabel } : {})}
        {...(field.maxTags !== undefined ? { maxItems: field.maxTags } : {})}
        placeholder={
          field.placeholder ?? t('uiLibrary.configFormField.searchOrAdd', 'Search or add…')
        }
        testId={`config-tags-${field.key}`}
      />
    </FieldWrapper>
  )
}

export function NodeSelectField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigNodeSelectField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}): JSX.Element | null {
  const t = useUiText()
  const { nodes } = useClusterNodesHook()
  const current = typeof value === 'string' ? value : ''
  const filtered = field.showOffline ? nodes : nodes.filter((n) => n.isOnline)
  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
      translationFn={translationFn}
    >
      <select
        className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50"
        value={current}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">{t('uiLibrary.configFormField.selectNode', 'Select node…')}</option>
        {filtered.map((n) => (
          <option key={n.id} value={n.id} disabled={!n.isOnline}>
            {n.isOnline
              ? n.shortName
              : t('uiLibrary.configFormField.nodeOffline', '{{name}} (offline)', {
                  name: n.shortName,
                })}
          </option>
        ))}
      </select>
    </FieldWrapper>
  )
}

export function NodeMultiSelectField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigNodeMultiSelectField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}): JSX.Element | null {
  const { nodes } = useClusterNodesHook()
  const selected = new Set(Array.isArray(value) ? value.map(String) : [])
  const filtered = field.showOffline ? nodes : nodes.filter((n) => n.isOnline)
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }
  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
      translationFn={translationFn}
    >
      <div className="flex flex-wrap gap-1.5">
        {filtered.map((n) => {
          const isOn = selected.has(n.id)
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => toggle(n.id)}
              disabled={disabled || !n.isOnline}
              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
                isOn
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-surface text-foreground-subtle hover:bg-surface-hover'
              } ${!n.isOnline ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {n.shortName}
            </button>
          )
        })}
      </div>
    </FieldWrapper>
  )
}

function ColorField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigColorField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}) {
  const strVal = value === undefined || value === null ? '#000000' : String(value)

  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
      translationFn={translationFn}
    >
      <div className="flex items-center gap-2">
        <input
          type="color"
          className="h-9 w-9 rounded-md border border-border bg-background cursor-pointer p-0.5 disabled:opacity-50"
          value={strVal}
          disabled={disabled || field.disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          type="text"
          className={INPUT_CLASS + ' flex-1 font-mono'}
          value={strVal}
          placeholder="#000000"
          disabled={disabled || field.disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {field.presets && field.presets.length > 0 && (
        <div className="flex gap-1.5 mt-1.5">
          {field.presets.map((preset) => (
            <button
              key={preset}
              type="button"
              className="h-5 w-5 rounded-md border border-border hover:scale-110 transition-transform disabled:opacity-50"
              style={{ backgroundColor: preset }}
              disabled={disabled || field.disabled}
              title={preset}
              onClick={() => onChange(preset)}
            />
          ))}
        </div>
      )}
    </FieldWrapper>
  )
}

function IconField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigIconField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}) {
  const defaultKey = typeof field.default === 'string' ? field.default : ''
  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
      translationFn={translationFn}
    >
      <ConfigIconFieldControl
        label={resolveLabel(field.label, translationFn) ?? field.label}
        value={value}
        defaultKey={defaultKey}
        disabled={disabled || field.disabled}
        onChange={onChange}
      />
    </FieldWrapper>
  )
}

function ProbeField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
  onTestField,
  onAction,
  externalProbe,
}: {
  field: ConfigProbeField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
  onTestField?: (key: string, value: unknown) => Promise<FieldProbeResult>
  onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
  externalProbe?: { status: 'probing' | 'ok' | 'error'; result?: FieldProbeResult }
}) {
  const t = useUiText()
  const [localStatus, setLocalStatus] = useState<'idle' | 'probing' | 'ok' | 'error'>('idle')
  const [localResult, setLocalResult] = useState<FieldProbeResult | null>(null)

  // External probe (from "Test All") takes precedence over local state
  const probeStatus = externalProbe?.status ?? localStatus
  const probeResult = externalProbe?.result ?? localResult

  // Prefer the dedicated `onTestField` (creation dialog) when present —
  // its signature matches directly. Otherwise fall back to the generic
  // inline-action pipe via `onAction('test-probe', key, value)` so the
  // device-settings page unifies probing with its other actions
  // (copy-value, regenerate-rtsp-token).
  const hasTestHandler = !!onTestField || !!onAction

  const handleTest = useCallback(async () => {
    if (!hasTestHandler) return
    setLocalStatus('probing')
    setLocalResult(null)
    try {
      const result = onTestField
        ? await onTestField(field.key, value)
        : ((await onAction!('test-probe', field.key, value)) as FieldProbeResult | undefined)
      const safeResult: FieldProbeResult =
        result && typeof result === 'object'
          ? result
          : {
              status: 'error',
              error: t(
                'uiLibrary.configFormField.probeNoResult',
                'Probe handler returned no result',
              ),
            }
      setLocalResult(safeResult)
      setLocalStatus(safeResult.status === 'ok' ? 'ok' : 'error')
    } catch (err) {
      setLocalResult({ status: 'error', error: err instanceof Error ? err.message : String(err) })
      setLocalStatus('error')
    }
  }, [onTestField, onAction, field.key, value, hasTestHandler])

  // Button styling per probe status — the test button IS the
  // status indicator, so it changes color + icon to reflect probe
  // state. Idle = neutral border (default look). Probing = primary
  // tint + spinner. OK = success tint + checkmark. Error = danger
  // tint + alert. The standalone status icon to the left of the
  // input is gone — the button color carries that signal.
  const buttonStateClass =
    probeStatus === 'probing'
      ? 'border-primary/40 bg-primary/10 text-primary'
      : probeStatus === 'ok'
        ? 'border-success/40 bg-success/10 text-success hover:bg-success/15'
        : probeStatus === 'error'
          ? 'border-danger/40 bg-danger/10 text-danger hover:bg-danger/15'
          : 'border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover'
  const buttonIcon =
    probeStatus === 'probing' ? (
      <Loader2 className="h-3 w-3 animate-spin" />
    ) : probeStatus === 'ok' ? (
      <CheckCircle className="h-3 w-3" />
    ) : probeStatus === 'error' ? (
      <AlertCircle className="h-3 w-3" />
    ) : (
      <Wifi className="h-3 w-3" />
    )

  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
      translationFn={translationFn}
    >
      <div className="@container flex items-center gap-2" style={{ containerType: 'inline-size' }}>
        <button
          type="button"
          onClick={handleTest}
          title={t('uiLibrary.configFormField.test', 'Test')}
          // Probe is orthogonal to save/edit disabling: a user wants to
          // verify an RTSP URL even while a batch save is mid-flight, so
          // we don't gate on the parent `disabled`. Only the field's own
          // `field.disabled`, an in-flight probe, a missing value, or
          // having neither handler can lock it out.
          disabled={field.disabled || probeStatus === 'probing' || !hasTestHandler || !value}
          className={`flex-shrink-0 inline-flex items-center gap-1.5 rounded-md border px-2 py-2 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed @[280px]:px-3 ${buttonStateClass}`}
        >
          {buttonIcon}
          {/* Label only when the FIELD CELL is wide enough to fit
              button + input comfortably (~280px). Below that the
              status icon + button color carry the affordance. */}
          <span className="hidden @[280px]:inline">
            {t('uiLibrary.configFormField.test', 'Test')}
          </span>
        </button>
        <input
          type={field.inputType ?? 'url'}
          className={INPUT_CLASS + ' flex-1 min-w-0'}
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={field.placeholder}
          disabled={disabled || field.disabled}
          onChange={(e) => {
            onChange(e.target.value)
            // Reset local probe state when input changes
            if (localStatus !== 'idle') {
              setLocalStatus('idle')
              setLocalResult(null)
            }
          }}
        />
      </div>
      {/* Success: show label chips */}
      {probeStatus === 'ok' && probeResult?.labels && probeResult.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {probeResult.labels.map((label, i) => (
            <span
              key={i}
              className="text-xs bg-success/10 text-success rounded px-2 py-0.5 font-mono"
            >
              {label}
            </span>
          ))}
        </div>
      )}
      {/* Error: show error message */}
      {probeStatus === 'error' && probeResult?.error && (
        <p className="text-xs text-danger mt-1 truncate" title={probeResult.error}>
          {probeResult.error}
        </p>
      )}
    </FieldWrapper>
  )
}

function GroupField({
  field,
  values,
  onChange,
  onChangeMany,
  disabled,
  translationFn,
  onTestField,
  onAction,
}: {
  field: ConfigGroupField
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  onChangeMany?: (patch: Record<string, unknown>) => void
  disabled?: boolean
  translationFn?: TranslationFn
  onTestField?: (key: string, value: unknown) => Promise<FieldProbeResult>
  onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
}) {
  const [collapsed, setCollapsed] = useState(field.defaultCollapsed ?? false)
  const isAccordion = field.style === 'accordion'

  const colSpanClass =
    field.span === 2
      ? 'col-span-2'
      : field.span === 3
        ? 'col-span-3'
        : field.span === 4
          ? 'col-span-4'
          : 'col-span-1'

  return (
    <div className={`${colSpanClass} min-w-0`}>
      <div
        className="@container rounded-lg border border-border bg-surface/50 overflow-hidden"
        style={{ containerType: 'inline-size' }}
      >
        <div
          className={[
            'px-3 py-2 flex items-center justify-between min-w-0',
            isAccordion ? 'cursor-pointer hover:bg-surface' : '',
          ].join(' ')}
          onClick={isAccordion ? () => setCollapsed((c) => !c) : undefined}
        >
          <span className="text-xs font-semibold text-foreground min-w-0 break-words">
            {resolveLabel(field.label, translationFn)}
          </span>
          {isAccordion && (
            <span className="text-foreground-subtle text-xs shrink-0 ml-2">
              {collapsed ? '▸' : '▾'}
            </span>
          )}
        </div>
        {!collapsed && (
          <div className="px-3 pb-3 grid grid-cols-1 @[480px]:grid-cols-2 gap-x-4 gap-y-3">
            {field.fields.map((subField) => (
              <FormField
                key={subField.key}
                field={subField}
                values={values}
                onChange={onChange}
                onChangeMany={onChangeMany}
                disabled={disabled}
                translationFn={translationFn}
                onTestField={onTestField}
                onAction={onAction}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SubTabsField({
  field,
  values,
  onChange,
  disabled,
  translationFn,
  onTestField,
  onAction,
}: {
  field: ConfigSubTabsField
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
  onTestField?: (key: string, value: unknown) => Promise<FieldProbeResult>
  onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
}) {
  const firstId = field.tabs[0]?.id ?? ''
  const [active, setActive] = useState<string>(firstId)

  const colSpanClass =
    field.span === 2
      ? 'col-span-2'
      : field.span === 3
        ? 'col-span-3'
        : field.span === 4
          ? 'col-span-4'
          : 'col-span-1'

  if (field.tabs.length === 0) return null

  // Distinct visual treatment from the page-level tab bar:
  //   - chip-shaped triggers laid out in a wrapping flex (no scrolling)
  //   - active state uses solid primary background instead of an
  //     underline so it reads as "secondary nav inside this section"
  //     rather than another top-level tab bar
  //   - container framed with a subdued border + background tint
  return (
    <div className={`${colSpanClass} min-w-0`}>
      {field.label && <div className={LABEL_CLASS}>{resolveLabel(field.label, translationFn)}</div>}
      <div
        className="@container rounded-lg border border-border-subtle bg-surface-hover/40 overflow-hidden"
        style={{ containerType: 'inline-size' }}
      >
        <div
          className="flex flex-wrap gap-1 p-1.5 border-b border-border-subtle bg-surface/40"
          role="tablist"
        >
          {field.tabs.map((t) => {
            const isActive = t.id === active
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActive(t.id)}
                className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                  isActive
                    ? 'bg-primary text-primary-foreground font-medium shadow-sm'
                    : 'bg-transparent text-foreground-subtle hover:bg-surface hover:text-foreground'
                }`}
              >
                <span>{resolveLabel(t.label, translationFn)}</span>
                {t.badge && (
                  <span
                    className={`text-[9px] px-1 py-0.5 rounded-full font-medium ${
                      isActive
                        ? 'bg-primary-foreground/20 text-primary-foreground'
                        : 'bg-primary/10 text-primary'
                    }`}
                  >
                    {t.badge}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        {field.tabs.map((t) => {
          if (t.id !== active) return null
          return (
            <div
              key={t.id}
              role="tabpanel"
              className="px-3 pb-3 pt-2 grid grid-cols-1 @[480px]:grid-cols-2 gap-x-4 gap-y-3"
            >
              {t.fields.map((subField, idx) => {
                const stableKey =
                  'key' in subField && typeof subField.key === 'string'
                    ? subField.key
                    : `__${t.id}__${idx}`
                return (
                  <FormField
                    key={stableKey}
                    field={subField}
                    values={values}
                    onChange={onChange}
                    disabled={disabled}
                    translationFn={translationFn}
                    onTestField={onTestField}
                    onAction={onAction}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// `model-selector` field type is no longer rendered natively — host
// apps register a renderer via `<CustomFieldRenderersProvider>` that
// can talk to the model catalog cap (admin-ui:
// `components/form-builder/ModelSelector` adapter). Without a registered
// renderer the field falls through `default:` and renders nothing.

function SeparatorField({ span }: { span?: number }) {
  const colSpanClass =
    span === 2
      ? 'col-span-2'
      : span === 3
        ? 'col-span-3'
        : span === 4
          ? 'col-span-4'
          : 'col-span-full'

  return (
    <div className={colSpanClass}>
      <hr className="border-border" />
    </div>
  )
}

const INFO_VARIANT_STYLES: Record<string, { border: string; bg: string; text: string }> = {
  info: { border: 'border-info', bg: 'bg-info/5', text: 'text-info' },
  warning: { border: 'border-warning', bg: 'bg-warning/5', text: 'text-warning' },
  success: { border: 'border-success', bg: 'bg-success/5', text: 'text-success' },
  danger: { border: 'border-danger', bg: 'bg-danger/5', text: 'text-danger' },
}

function InfoBox({ field }: { field: ConfigInfoField }) {
  const variant = field.variant ?? 'info'
  const styles = INFO_VARIANT_STYLES[variant] ?? INFO_VARIANT_STYLES['info']!
  const isHtml = field.format === 'html'

  return (
    <div className="col-span-full">
      <div className={`rounded-md border-l-4 px-3 py-2.5 ${styles.border} ${styles.bg}`}>
        {field.label && (
          <p className={`text-xs font-semibold mb-0.5 ${styles.text}`}>{field.label}</p>
        )}
        {isHtml ? (
          <div
            className="text-xs text-foreground-subtle leading-relaxed info-html-content"
            // Source is addon-authored copy bundled at build time, not
            // user input; `sanitizeInfoHtml` is the additional safety
            // net (allowlist of tags + href schemes).
            dangerouslySetInnerHTML={{ __html: sanitizeInfoHtml(field.content) }}
          />
        ) : (
          <p className="text-xs text-foreground-subtle leading-relaxed whitespace-pre-line">
            {field.content}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Renders a `ConfigQrCodeField` — scannable QR for an arbitrary string
 * payload (HomeKit `X-HM://…` pairing URI, OAuth device-flow code, …).
 *
 * When the field's `value` is empty or absent the whole block is
 * suppressed so addons can return the field unconditionally without
 * leaking "no pairing yet" placeholders into the form.
 */
function QrCodeBox({ field }: { field: ConfigQrCodeField }) {
  const value = field.value
  if (!value || value.length === 0) return null
  const size = field.size ?? 192
  const alt = field.alt ?? field.label
  return (
    <div className="col-span-full">
      <div className="rounded-md border border-foreground-subtle/20 px-3 py-3 bg-background-subtle/40 flex flex-col items-start gap-2">
        {field.label && <p className="text-xs font-semibold text-foreground">{field.label}</p>}
        {field.caption && (
          <p className="text-xs text-foreground-subtle leading-relaxed">{field.caption}</p>
        )}
        <QrCode value={value} size={size} alt={alt} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Object Array (readonly diagnostic table)
// ---------------------------------------------------------------------------

const STATUS_DOT_STYLES: Record<string, string> = {
  ok: 'bg-success',
  warn: 'bg-amber-500',
  danger: 'bg-danger',
  idle: 'bg-foreground-subtle/40',
  unknown: 'bg-foreground-subtle/40',
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return new Date(ms).toLocaleTimeString()
}

function ObjectArrayCell({
  kind,
  value,
}: {
  kind?: ConfigObjectArrayField['columns'][number]['kind']
  value: unknown
}) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-foreground-subtle/60">—</span>
  }
  if (kind === 'monospace') {
    return <span className="font-mono text-[11px]">{String(value)}</span>
  }
  if (kind === 'status') {
    const k = String(value).toLowerCase()
    const dot = STATUS_DOT_STYLES[k] ?? STATUS_DOT_STYLES['unknown']!
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
        <span>{String(value)}</span>
      </span>
    )
  }
  if (kind === 'duration' && typeof value === 'number') {
    return <span className="font-mono text-[11px]">{formatDuration(value)}</span>
  }
  if (kind === 'timestamp' && typeof value === 'number') {
    return <span className="font-mono text-[11px]">{formatTimestamp(value)}</span>
  }
  return <span>{String(value)}</span>
}

function ObjectArrayField({ field }: { field: ConfigObjectArrayField }) {
  const t = useUiText()
  const rows = field.value ?? []
  const description = field.description
  return (
    <div className="col-span-full">
      {field.label && (
        <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground-subtle mb-1">
          {field.label}
        </p>
      )}
      {description && <p className="text-xs text-foreground-subtle mb-2">{description}</p>}
      {rows.length === 0 ? (
        <div className="rounded-md border border-border bg-surface-subtle px-3 py-2 text-xs text-foreground-subtle">
          {field.emptyMessage ?? t('uiLibrary.configFormField.noEntries', 'No entries')}
        </div>
      ) : (
        // The column set comes from the addon's schema, so this table can be
        // arbitrarily wide. It renders inside `AdminPage`, whose body is
        // `overflow-x-clip` — clip has NO scrollbar, so without a scroller of
        // its own the overflowing columns are simply unreachable on a phone.
        // `overflow-x-auto` still clips to the border radius, so the rounding
        // the old `overflow-hidden` was there for survives.
        <div className="rounded-md border border-border overflow-x-auto">
          <table className="w-full min-w-[28rem] text-xs">
            <thead className="bg-surface-subtle border-b border-border">
              <tr>
                {field.columns.map((col) => (
                  <th
                    key={col.key}
                    className="px-3 py-1.5 text-left font-medium text-foreground-subtle"
                    style={col.width ? { width: col.width } : undefined}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row, i) => (
                <tr key={i} className="hover:bg-surface-hover/40">
                  {field.columns.map((col) => (
                    <td key={col.key} className="px-3 py-1.5 align-top text-foreground">
                      <ObjectArrayCell kind={col.kind} value={row[col.key]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Editable Array
// ---------------------------------------------------------------------------

/**
 * Editable array of records — renders one bordered card per row,
 * each card hosts the `field.itemFields` schema rendered via the
 * standard FormField recursion. Add/Remove buttons mutate the array
 * and propagate via `onChange`. Used by addons that need
 * "configure N items" (e.g. an SFTP backup addon listing N remote
 * destinations) without inventing a custom-renderer.
 */
function EditableArrayField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
  onTestField,
  onAction,
}: {
  field: ConfigEditableArrayField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
  onTestField?: (key: string, value: unknown) => Promise<FieldProbeResult>
  onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
}) {
  const t = useUiText()
  const rows: Array<Record<string, unknown>> = Array.isArray(value)
    ? (value as Array<Record<string, unknown>>)
    : []
  const minRows = field.minRows ?? 0
  const maxRows = field.maxRows ?? Number.POSITIVE_INFINITY

  const updateRow = (idx: number, key: string, v: unknown): void => {
    const next = rows.slice()
    const existing = next[idx] ?? {}
    next[idx] = { ...existing, [key]: v }
    onChange(next)
  }
  const removeRow = (idx: number): void => {
    if (rows.length <= minRows) return
    onChange(rows.filter((_, i) => i !== idx))
  }
  const addRow = (): void => {
    if (rows.length >= maxRows) return
    const seed: Record<string, unknown> = field.defaultItem ?? {}
    onChange([...rows, { ...seed }])
  }

  const resolveRowTitle = (row: Record<string, unknown>, idx: number): string => {
    if (!field.rowTitleTemplate)
      return t('uiLibrary.configFormField.row', 'Row {{n}}', { n: idx + 1 })
    return field.rowTitleTemplate.replace(/\{(\w+)\}/g, (_match, key: string) => {
      const v = row[key]
      return v === undefined || v === null || v === '' ? '—' : String(v)
    })
  }

  const canRemove = rows.length > minRows
  const canAdd = rows.length < maxRows
  const idKey = field.itemIdKey ?? 'id'
  const rowReactKey = (row: Record<string, unknown>, idx: number): string => {
    const raw = row[idKey]
    if (typeof raw === 'string' && raw.length > 0) return raw
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
    return `row-${String(idx)}`
  }

  return (
    <div className="col-span-full space-y-2">
      <div className="space-y-0.5">
        {field.label && (
          <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground-subtle">
            {resolveLabel(field.label, translationFn)}
          </p>
        )}
        {field.description && (
          <p className="text-[11px] text-foreground-subtle">
            {resolveLabel(field.description, translationFn)}
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-background px-3 py-3 text-center text-[11px] text-foreground-subtle">
          {field.emptyMessage ?? t('uiLibrary.configFormField.noEntries', 'No entries')}
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row, idx) => (
            <div
              key={rowReactKey(row, idx)}
              className="rounded-md border border-border bg-background"
            >
              <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                <span className="text-xs font-medium text-foreground">
                  {resolveRowTitle(row, idx)}
                </span>
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  disabled={disabled || !canRemove}
                  className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-danger hover:bg-danger/10 disabled:opacity-30 disabled:cursor-not-allowed"
                  title={
                    !canRemove
                      ? t(
                          'uiLibrary.configFormField.minRows',
                          {
                            one: 'At least {{count}} row required',
                            other: 'At least {{count}} rows required',
                          },
                          { count: minRows },
                        )
                      : t('uiLibrary.configFormField.removeRow', 'Remove this row')
                  }
                >
                  <Minus className="h-3 w-3" />
                  {t('uiLibrary.configFormField.remove', 'Remove')}
                </button>
              </div>
              <div className="grid grid-cols-1 @[480px]:grid-cols-2 gap-x-3 gap-y-2 p-3">
                {field.itemFields.map((sub) => (
                  <FormField
                    key={sub.key}
                    field={sub}
                    values={row}
                    onChange={(k, v) => updateRow(idx, k, v)}
                    disabled={disabled}
                    translationFn={translationFn}
                    onTestField={onTestField}
                    allFields={field.itemFields}
                    onAction={onAction}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={addRow}
          disabled={disabled || !canAdd}
          className="inline-flex items-center gap-1 rounded border border-border bg-surface px-3 py-1 text-[11px] font-medium text-foreground hover:border-primary/40 hover:bg-primary/5 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Plus className="h-3 w-3" />
          {field.addLabel ?? t('uiLibrary.configFormField.add', 'Add')}
        </button>
        {!canAdd && Number.isFinite(maxRows) && (
          <span className="ml-2 text-[10px] text-foreground-subtle">
            {t('uiLibrary.configFormField.limit', '(limit: {{max}})', { max: maxRows })}
          </span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

function ButtonField({
  field,
  disabled,
  onAction,
}: {
  readonly field: ConfigButtonField
  readonly disabled?: boolean
  readonly onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
}) {
  const t = useUiText()
  const [loading, setLoading] = useState(false)
  const confirm = useConfirm()

  const handleClick = async () => {
    if (field.confirmMessage) {
      const ok = await confirm({
        title: field.label,
        message: field.confirmMessage,
        confirmLabel: field.buttonLabel,
        variant: field.variant === 'danger' ? 'danger' : 'default',
      })
      if (!ok) return
    }
    if (!onAction) return
    setLoading(true)
    try {
      await onAction(field.action, field.key)
    } finally {
      setLoading(false)
    }
  }

  const variantClasses: Record<string, string> = {
    default: 'border border-border text-foreground hover:bg-surface-hover',
    primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
    danger: 'bg-danger text-white hover:bg-danger/90',
  }

  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
    >
      <button
        onClick={handleClick}
        disabled={disabled || loading}
        className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
          variantClasses[field.variant ?? 'default'] ?? variantClasses['default']
        }`}
      >
        {loading ? t('uiLibrary.configFormField.processing', 'Processing...') : field.buttonLabel}
      </button>
    </FieldWrapper>
  )
}

// ---------------------------------------------------------------------------
// AddonActionSelectField — options pulled live from a customAction
// ---------------------------------------------------------------------------
//
// Generalises "paste a token, server returns the list you can pick from"
// (Cloudflare zones, S3 buckets, …). Resolves `paramsFromForm` against
// the current form snapshot, invokes the action via the parent's
// `onAction(action, key, input)` channel, and renders the result as a
// `<select>` whose option labels/values are mapped per `field.mapOption`.

function resolveActionParams(
  field: {
    paramsFromForm?: Readonly<Record<string, string>>
    paramsStatic?: Readonly<Record<string, unknown>>
  },
  values: Record<string, unknown>,
): Record<string, unknown> {
  const params: Record<string, unknown> = { ...field.paramsStatic }
  if (field.paramsFromForm) {
    for (const [paramKey, formKey] of Object.entries(field.paramsFromForm)) {
      const v = values[formKey]
      // A keychain secret the form knows only as its view is sent AS the view:
      // the action's owner resolves it to its own stored value (D789). A
      // pending "Clear" is never a parameter.
      if (v !== undefined && v !== null && v !== '' && !isSecretClear(v)) params[paramKey] = v
    }
  }
  return params
}

function AddonActionSelectField({
  field,
  value,
  values,
  onChange,
  disabled,
  onAction,
}: {
  readonly field: ConfigAddonActionSelectField
  readonly value: unknown
  readonly values: Record<string, unknown>
  readonly onChange: (v: unknown) => void
  readonly disabled?: boolean
  readonly onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
}) {
  const t = useUiText()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [options, setOptions] = useState<readonly Record<string, unknown>[] | null>(null)

  const params = resolveActionParams(field, values)
  const missingParam = Object.keys(field.paramsFromForm ?? {}).some((k) => params[k] === undefined)
  const valueKey = field.mapOption.value
  const labelKey = field.mapOption.label
  const descKey = field.mapOption.description

  // Refresh whenever any `refreshOn` key changes — serialise into a
  // dependency string the useEffect can diff on.
  const refreshKey = (field.refreshOn ?? Object.values(field.paramsFromForm ?? {}))
    .map((k) => `${k}=${JSON.stringify(values[k])}`)
    .join('|')

  // Calling the action updates the parent (the mutation goes pending, then
  // settles). Add integration builds a new `onAction` on that render. Depending
  // on the function identity re-enters this effect and `setLoading` until React
  // hits its update limit (#185) — Bosch SHC's discover select loads immediately,
  // so opening it is enough. Read the latest callback from a ref; reload only
  // when the inputs that define the request change.
  const onActionRef = useRef(onAction)
  onActionRef.current = onAction
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const paramsRef = useRef(params)
  paramsRef.current = params
  const valueRef = useRef(value)
  valueRef.current = value
  const hasAction = onAction !== undefined

  useEffect(() => {
    const run = onActionRef.current
    if (!run || missingParam) {
      setOptions(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const requested = paramsRef.current
    run(field.action, field.key, requested)
      .then((res) => {
        if (cancelled) return
        // Convention: the action returns an envelope `{<plural>: [...]}` —
        // walk one level to find the first array property.
        const result = res as Record<string, unknown> | unknown[]
        let list: readonly Record<string, unknown>[] = []
        if (Array.isArray(result)) {
          list = result as readonly Record<string, unknown>[]
        } else if (result && typeof result === 'object') {
          for (const key of Object.keys(result)) {
            const candidate = (result as Record<string, unknown>)[key]
            if (Array.isArray(candidate)) {
              list = candidate as readonly Record<string, unknown>[]
              break
            }
          }
        }
        setOptions(list)
        const current = valueRef.current
        if (
          field.hideWhenFewerThan !== undefined &&
          list.length === 1 &&
          (typeof current !== 'string' || current.length === 0)
        ) {
          const only = list[0]?.[valueKey]
          if (typeof only === 'string' && only.length > 0) onChangeRef.current(only)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setOptions([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    refreshKey,
    missingParam,
    hasAction,
    field.action,
    field.key,
    field.hideWhenFewerThan,
    valueKey,
  ])

  if (!onAction && field.hideWhenFewerThan !== undefined) return null
  if (
    field.hideWhenFewerThan !== undefined &&
    options !== null &&
    options.length < field.hideWhenFewerThan
  ) {
    return null
  }

  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
    >
      {missingParam ? (
        <div className="text-[11px] text-foreground-subtle italic">
          {field.emptyParamsMessage ??
            t(
              'uiLibrary.configFormField.fillPrerequisites',
              'Fill the prerequisite fields above first.',
            )}
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 text-[11px] text-foreground-subtle">
          <Loader2 className="h-3 w-3 animate-spin" />{' '}
          {t('uiLibrary.configFormField.loadingOptions', 'Loading options…')}
        </div>
      ) : error ? (
        <div className="text-[11px] text-danger">{error}</div>
      ) : options && options.length === 0 ? (
        <div className="text-[11px] text-foreground-subtle italic">
          {field.emptyResultsMessage ??
            t('uiLibrary.configFormField.noOptions', 'No options returned.')}
        </div>
      ) : (
        (() => {
          // The cap-supplied options may already include an "" entry that
          // represents an explicit sentinel (e.g. "Auto" in the cloudflare
          // tunnel address picker). In that case skip the auto-injected
          // "— Select —" placeholder — otherwise the DOM ends up with
          // two `<option value="">` siblings and the operator's Auto
          // choice gets silently clobbered onto the placeholder.
          const hasEmptyValueOption = (options ?? []).some((row) => {
            const v = row[valueKey]
            return v === '' || v === undefined
          })
          return (
            <select
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
              value={typeof value === 'string' ? value : ''}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
            >
              {!hasEmptyValueOption && (
                <option value="">{t('uiLibrary.configFormField.select', '— Select —')}</option>
              )}
              {(options ?? []).map((row, i) => {
                const v = row[valueKey]
                const l = row[labelKey]
                const d = descKey ? row[descKey] : undefined
                const key = typeof v === 'string' && v !== '' ? v : `row-${i}`
                return (
                  <option key={key} value={typeof v === 'string' ? v : String(v ?? '')}>
                    {typeof l === 'string' ? l : String(l ?? key)}
                    {d !== undefined ? ` (${String(d)})` : ''}
                  </option>
                )
              })}
            </select>
          )
        })()
      )}
    </FieldWrapper>
  )
}

// ---------------------------------------------------------------------------
// AddonActionButtonField — fires a customAction with resolved form params
// ---------------------------------------------------------------------------
//
// Same shape as ButtonField but resolves `paramsFromForm` + `paramsStatic`
// against the current form snapshot and ships them through `onAction(...,
// input)`. Provides the "Verify token" / "Provision tunnel" UX without
// each addon hand-rolling a settings page.

function AddonActionButtonField({
  field,
  values,
  disabled,
  onAction,
  onChange,
  onChangeMany,
}: {
  readonly field: ConfigAddonActionButtonField
  readonly values: Record<string, unknown>
  readonly disabled?: boolean
  readonly onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
  readonly onChange?: (key: string, value: unknown) => void
  readonly onChangeMany?: (patch: Record<string, unknown>) => void
}) {
  const t = useUiText()
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const confirm = useConfirm()
  const prompt = usePrompt()
  // The form's device, for an action that declared it needs one. A device id is
  // CONTEXT, not a value the operator typed, so it cannot come from
  // `paramsFromForm` — and without it an addon action simply could not be
  // offered on a per-camera form.
  const deviceId = useDeviceId()

  const handleClick = async () => {
    // A one-shot argument asked for here, so it never becomes a saved setting.
    const asked = field.prompt
      ? await prompt({
          title: field.prompt.title ?? field.label,
          ...(field.prompt.message !== undefined ? { message: field.prompt.message } : {}),
          ...(field.prompt.placeholder !== undefined
            ? { placeholder: field.prompt.placeholder }
            : {}),
          confirmLabel: field.buttonLabel,
        })
      : null
    if (field.prompt && asked === null) return
    if (field.confirmMessage) {
      const ok = await confirm({
        title: field.label,
        message: field.confirmMessage,
        confirmLabel: field.buttonLabel,
        variant: field.variant === 'danger' ? 'danger' : 'default',
      })
      if (!ok) return
    }
    if (!onAction) return
    const params = resolveActionParams(field, values)
    if (field.prompt && asked !== null) params[field.prompt.param] = asked
    if (field.includeDeviceId === true && deviceId !== null && deviceId !== undefined) {
      params['deviceId'] = deviceId
    }
    setLoading(true)
    setStatus(null)
    try {
      const result = await onAction(field.action, field.key, params)
      const resultRecord =
        typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : null
      if (resultRecord !== null && field.assignResult && (onChange || onChangeMany)) {
        const patch: Record<string, unknown> = {}
        for (const [formKey, resultKey] of Object.entries(field.assignResult)) {
          const assigned = resultRecord[resultKey]
          if (typeof assigned === 'string') patch[formKey] = assigned
        }
        if (Object.keys(patch).length > 0) {
          if (onChangeMany) {
            onChangeMany(patch)
          } else if (onChange) {
            for (const [formKey, assigned] of Object.entries(patch)) {
              onChange(formKey, assigned)
            }
          }
        }
      }
      const successText = field.successMessage
        ? field.successMessage.replace(/\{(\w+)\}/g, (_, k: string) => {
            const v = resultRecord?.[k]
            return v === undefined ? '' : String(v)
          })
        : 'Done.'
      setStatus({ kind: 'ok', text: successText })
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setLoading(false)
    }
  }

  const variantClasses: Record<string, string> = {
    default: 'border border-border text-foreground hover:bg-surface-hover',
    primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
    danger: 'bg-danger text-white hover:bg-danger/90',
  }

  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
    >
      <div className="flex flex-col gap-1.5">
        <button
          onClick={handleClick}
          disabled={disabled || loading}
          className={`inline-flex w-fit items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
            variantClasses[field.variant ?? 'default'] ?? variantClasses['default']
          }`}
        >
          {loading ? t('uiLibrary.configFormField.working', 'Working…') : field.buttonLabel}
        </button>
        {status && (
          <div
            className={`text-[11px] ${status.kind === 'ok' ? 'text-emerald-700 dark:text-emerald-300' : 'text-danger'}`}
          >
            {status.text}
          </div>
        )}
      </div>
    </FieldWrapper>
  )
}

// DeviceActionButtonField — device equivalent of AddonActionButtonField
// ---------------------------------------------------------------------------
//
// Fires a device custom-action via the fixed 'device-custom-action'
// discriminator so the device form's handleAction routes ALL device actions
// through one branch. The field's `action` rides in the `key` slot of the
// onAction call; `value` carries the resolved input params.

function DeviceActionButtonField({
  field,
  values,
  disabled,
  onAction,
}: {
  readonly field: ConfigDeviceActionButtonField
  readonly values: Record<string, unknown>
  readonly disabled?: boolean
  readonly onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
}) {
  const t = useUiText()
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const confirm = useConfirm()

  const handleClick = async () => {
    if (field.confirmMessage) {
      const ok = await confirm({
        title: field.label,
        message: field.confirmMessage,
        confirmLabel: field.buttonLabel,
        variant: field.variant === 'danger' ? 'danger' : 'default',
      })
      if (!ok) return
    }
    if (!onAction) return
    const params = resolveActionParams(field, values)
    setLoading(true)
    setStatus(null)
    try {
      const result = await onAction('device-custom-action', field.action, params)
      const resultRecord =
        typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : null
      const successText = field.successMessage
        ? field.successMessage.replace(/\{(\w+)\}/g, (_, k: string) => {
            const v = resultRecord?.[k]
            return v === undefined ? '' : String(v)
          })
        : 'Done.'
      setStatus({ kind: 'ok', text: successText })
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setLoading(false)
    }
  }

  const variantClasses: Record<string, string> = {
    default: 'border border-border text-foreground hover:bg-surface-hover',
    primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
    danger: 'bg-danger text-white hover:bg-danger/90',
  }

  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={field.required}
      span={field.span}
    >
      <div className="flex flex-col gap-1.5">
        <button
          onClick={handleClick}
          disabled={disabled || loading}
          className={`inline-flex w-fit items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
            variantClasses[field.variant ?? 'default'] ?? variantClasses['default']
          }`}
        >
          {loading ? t('uiLibrary.configFormField.working', 'Working…') : field.buttonLabel}
        </button>
        {status && (
          <div
            className={`text-[11px] ${status.kind === 'ok' ? 'text-emerald-700 dark:text-emerald-300' : 'text-danger'}`}
          >
            {status.text}
          </div>
        )}
      </div>
    </FieldWrapper>
  )
}

// ---------------------------------------------------------------------------
// Widget field — dispatches to <WidgetSlot> via the WidgetRegistry
// ---------------------------------------------------------------------------
//
// Generic addon-widget mount point inside a settings/overview form. The
// field declares the widget id (`<addonId>/<stableId>`) plus optional
// per-instance config; deviceId is read from the current
// `DeviceContext` so the field schema stays device-agnostic and addons
// can ship static contributions.
//
// Replaces the legacy per-type bespoke field types that required a
// dedicated custom-field renderer registered in admin-ui. New addon
// contributions should declare `type: 'widget'` and ship their React
// code through `addon-widgets-source` instead.
function WidgetField({ field }: { readonly field: ConfigWidgetField }) {
  const deviceId = useDeviceId()
  // A widget is a full-bleed component that renders its OWN internal
  // header — NOT a labelled scalar input. We pass no label/description
  // to FieldWrapper (a title would duplicate the widget's own header).
  // The wrapper IS needed so the widget honors its `span`: a `span: 2`
  // widget must fill both columns of the section's 2-col grid. Without
  // it the widget collapses to `col-span-1`, leaving half the row empty
  // and pulling the next field up beside it instead of below.
  return (
    <FieldWrapper label={undefined} description={undefined} span={field.span}>
      <WidgetSlot
        widgetId={field.widgetId}
        host="device-tab"
        config={field.widgetConfig}
        deviceId={deviceId ?? undefined}
        instanceId={field.key}
      />
    </FieldWrapper>
  )
}

// ---------------------------------------------------------------------------
// Readonly display field (aggregator live contributions)
// ---------------------------------------------------------------------------

function formatReadonlyValue(value: unknown, unit?: string): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') {
    const formatted = Number.isInteger(value) ? String(value) : value.toFixed(2)
    return unit ? `${formatted} ${unit}` : formatted
  }
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function ReadonlyDisplay({
  field,
  values,
  onAction,
  translationFn,
}: {
  field: ConfigField
  values: Record<string, unknown>
  onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
  translationFn?: TranslationFn
}) {
  const rawKey = 'key' in field ? field.key : undefined
  if (!rawKey) return null
  const rawValue = values[rawKey]
  const resolved =
    rawValue !== undefined ? rawValue : 'default' in field ? field.default : undefined
  const unit = 'unit' in field ? (field as { unit?: string }).unit : undefined
  const display = formatReadonlyValue(resolved, unit)
  const label = 'label' in field ? field.label : undefined
  const description = 'description' in field ? field.description : undefined
  const span = 'span' in field ? (field as { span?: number }).span : undefined
  const actions =
    'actions' in field ? ((field as { actions?: readonly FieldInlineAction[] }).actions ?? []) : []

  return (
    <FieldWrapper label={label} description={description} span={span} translationFn={translationFn}>
      <div className="flex items-stretch gap-1">
        <div className="flex-1 rounded-md border border-border bg-surface-alt px-2.5 py-1.5 text-xs text-foreground font-mono break-all">
          {display}
        </div>
        {actions.length > 0 && (
          <div className="flex items-center gap-1">
            {actions.map((a) => (
              <InlineActionIcon
                key={a.action}
                action={a}
                fieldKey={rawKey}
                value={resolved}
                onAction={onAction}
              />
            ))}
          </div>
        )}
      </div>
    </FieldWrapper>
  )
}

/**
 * Small lookup mapping icon ids emitted by addons to Lucide components.
 * Kept explicit (rather than a dynamic dictionary from `lucide-react`)
 * so the bundle only pulls in the icons we actually advertise. Unknown
 * icons fall back to a neutral wrench glyph.
 */
function InlineIconGlyph({ name }: { readonly name: string }): React.ReactElement {
  const cls = 'h-3.5 w-3.5'
  switch (name) {
    case 'copy':
      return <Copy className={cls} />
    case 'refresh-cw':
      return <RefreshCw className={cls} />
    case 'external-link':
      return <ExternalLink className={cls} />
    case 'trash-2':
      return <Trash2 className={cls} />
    case 'download':
      return <Download className={cls} />
    case 'upload':
      return <Upload className={cls} />
    default:
      return <Wrench className={cls} />
  }
}

/**
 * Compact icon button used inline on readonly fields (and — later — on
 * editable ones via the same `actions?: FieldInlineAction[]` slot).
 * Handles the `copy-value` action locally (writes the displayed value
 * to the clipboard) and forwards everything else to the shared
 * `onAction(action, key)` pipeline the rest of the FormBuilder uses.
 * Keeps the button-field + inline-icon code paths converged: a single
 * handler at the Device*Section level routes every action.
 */
function InlineActionIcon({
  action,
  fieldKey,
  value,
  onAction,
}: {
  action: FieldInlineAction
  fieldKey: string
  value: unknown
  onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
}) {
  const confirm = useConfirm()
  const [loading, setLoading] = useState(false)

  const variantClass =
    action.variant === 'danger'
      ? 'text-danger hover:bg-danger/10 border-danger/30'
      : action.variant === 'primary'
        ? 'text-primary hover:bg-primary/10 border-primary/30'
        : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover border-border'

  const handleClick = async () => {
    if (action.confirmMessage) {
      const ok = await confirm({
        title: action.tooltip,
        message: action.confirmMessage,
        variant: action.variant === 'danger' ? 'danger' : 'default',
      })
      if (!ok) return
    }
    if (action.action === 'copy-value') {
      try {
        await navigator.clipboard.writeText(typeof value === 'string' ? value : String(value))
      } catch {
        /* clipboard unavailable — silently skip */
      }
      return
    }
    if (!onAction) return
    setLoading(true)
    try {
      await onAction(action.action, fieldKey)
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      title={action.tooltip}
      className={`inline-flex items-center justify-center rounded-md border px-2 py-1.5 transition-colors disabled:opacity-50 ${variantClass}`}
    >
      <InlineIconGlyph name={action.icon} />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Multiple-field wrapper — renders any scalar-valued field as an array
// with per-item controls and a bounded +Add / Remove affordance.
// ---------------------------------------------------------------------------

/**
 * Any scalar-valued ConfigField carries ConfigFieldBase's full prop
 * surface (`key`, `label`, `multiple?`, `span?`, …). The structural
 * variants (`separator`, `info`) don't extend FieldBase and can't be
 * rendered as multiple. This predicate + its return type is what lets
 * `MultipleFieldWrapper` read `field.label` / spread the field without
 * TS erroring on the narrower shapes.
 */
type ConfigFieldWithMultiple = ConfigField & {
  readonly key: string
  readonly label: string
  readonly description?: string
  readonly required?: boolean
  readonly span?: 1 | 2 | 3 | 4
  readonly default?: unknown
  readonly multiple: NonNullable<Extract<ConfigField, { readonly multiple?: unknown }>['multiple']>
}

function hasMultiple(field: ConfigField): field is ConfigFieldWithMultiple {
  return 'multiple' in field && (field as { multiple?: unknown }).multiple != null
}

function MultipleFieldWrapper({
  field,
  values,
  onChange,
  disabled,
  translationFn,
  onTestField,
  externalProbe: _externalProbe,
  allFields,
  onAction,
}: FormFieldProps & { field: ConfigFieldWithMultiple }) {
  const t = useUiText()
  const multiple = field.multiple
  const min = multiple.min
  const max = multiple.max

  const raw = values[field.key]
  const stored: readonly unknown[] = Array.isArray(raw)
    ? raw
    : raw !== undefined && raw !== null
      ? [raw]
      : []
  // Pad up to `min` so the user always sees at least the required slots.
  const items: unknown[] = [...stored]
  const itemFallback: unknown =
    multiple.itemDefault !== undefined
      ? multiple.itemDefault
      : 'default' in field && field.default !== undefined
        ? field.default
        : ''
  while (items.length < min) items.push(itemFallback)

  const update = (next: readonly unknown[]) => onChange(field.key, [...next])
  const setItem = (idx: number, v: unknown) => {
    const next = [...items]
    next[idx] = v
    update(next)
  }
  const addItem = () => {
    if (items.length >= max) return
    update([...items, itemFallback])
  }
  const removeItem = (idx: number) => {
    if (items.length <= min) return
    update(items.filter((_, i) => i !== idx))
  }

  // Strip `multiple` from the child so FormField renders the underlying
  // scalar control. Always clear the inner label — the outer wrapper
  // (below) now renders any `itemLabel` HEADER above the row so the
  // per-row input sits on the same horizontal line as the trailing
  // delete button. Previously the inner label carved a header slot
  // inside the flex child, pushing the input down and leaving the
  // delete button "floating" next to the label instead of the input.
  const makeChild = (): ConfigField => {
    const { multiple: _drop, ...rest } = field
    const overrides = { label: undefined, description: undefined, required: false }
    const child: unknown = { ...rest, ...overrides }
    return child as ConfigField
  }

  return (
    <FieldWrapper
      label={field.label}
      description={field.description}
      required={min > 0 ? field.required : false}
      span={field.span}
      translationFn={translationFn}
    >
      <div className="space-y-2">
        {items.map((itemVal, idx) => {
          const itemLabel = multiple.itemLabel?.replace('${n}', String(idx + 1))
          return (
            <div key={idx} className="space-y-1">
              {itemLabel && <div className={LABEL_CLASS}>{itemLabel}</div>}
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <FormField
                    field={makeChild()}
                    // Inner FormField reads `values[field.key]` — project
                    // the per-slot value under the SAME key so the scalar
                    // renderer picks it up without a bespoke contract.
                    values={{ ...values, [field.key]: itemVal }}
                    onChange={(_k, v) => setItem(idx, v)}
                    disabled={disabled}
                    translationFn={translationFn}
                    onTestField={onTestField}
                    onAction={onAction}
                    allFields={allFields}
                  />
                </div>
                {items.length > min && (
                  <button
                    type="button"
                    onClick={() => removeItem(idx)}
                    disabled={disabled}
                    title={t('uiLibrary.configFormField.remove', 'Remove')}
                    className="flex-shrink-0 inline-flex items-center justify-center rounded-md border border-border p-1.5 text-foreground-subtle hover:text-danger hover:border-danger/50 transition-colors disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          )
        })}
        <div className="flex items-center justify-between pt-1">
          {items.length < max ? (
            <button
              type="button"
              onClick={addItem}
              disabled={disabled}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-40"
            >
              <Plus className="h-3 w-3" />
              {multiple.addLabel ?? t('uiLibrary.configFormField.add', 'Add')}
            </button>
          ) : (
            <span />
          )}
          <span className="text-[10px] text-foreground-subtle tabular-nums">
            {items.length}/{max}
          </span>
        </div>
      </div>
    </FieldWrapper>
  )
}

// ---------------------------------------------------------------------------
// showWhen evaluation
// ---------------------------------------------------------------------------

/**
 * Resolve a `ConfigCondition` against the form's flat values bag and the
 * sibling-field list (used to recover schema defaults when the
 * referenced field hasn't been touched yet). Returns `true` for fields
 * with no `showWhen` — i.e. always visible — and for fields whose
 * condition is missing a recognised operator (forward-compat: a future
 * operator added to `ConfigCondition` won't accidentally hide every
 * field on older clients).
 *
 * Exported so callers (FormBuilder section renderer, future
 * sub-tab visibility checks, …) can pre-evaluate which fields would be
 * rendered without instantiating a React subtree.
 */
export function isFieldVisible(
  field: ConfigField,
  values: Record<string, unknown>,
  allFields?: readonly ConfigField[],
): boolean {
  if (!('showWhen' in field) || !field.showWhen) return true
  const condition = field.showWhen
  const rawCondVal = values[condition.field]
  const condField = allFields?.find(
    (f): f is ConfigField & { key: string } => 'key' in f && f.key === condition.field,
  )
  const condDefault = condField && 'default' in condField ? condField.default : undefined
  const condVal = rawCondVal !== undefined ? rawCondVal : condDefault

  if (condition.equals !== undefined) return condVal === condition.equals
  if (condition.notEquals !== undefined) return condVal !== condition.notEquals
  if (condition.in !== undefined) return condition.in.includes(condVal)
  if (condition.notIn !== undefined) return !condition.notIn.includes(condVal)
  if (condition.includes !== undefined) {
    return Array.isArray(condVal) && condVal.includes(condition.includes)
  }
  if (condition.notIncludes !== undefined) {
    return !Array.isArray(condVal) || !condVal.includes(condition.notIncludes)
  }
  return true
}

// ---------------------------------------------------------------------------
// Main FormField component
// ---------------------------------------------------------------------------

export function FormField({
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
}: FormFieldProps): JSX.Element | null {
  // Multiple-mode short-circuit: treat the field as a collection of its
  // primitive. The wrapper materialises each slot and re-enters
  // FormField with `multiple` stripped so the switch below picks the
  // underlying scalar renderer.
  if (hasMultiple(field)) {
    return (
      <MultipleFieldWrapper
        field={field}
        values={values}
        onChange={onChange}
        disabled={disabled}
        translationFn={translationFn}
        onTestField={onTestField}
        externalProbe={externalProbe}
        allFields={allFields}
        onAction={onAction}
      />
    )
  }

  // Device-aggregator readonlyField short-circuit — render a static display
  // so live/readonly contributions don't ship a focusable input the user
  // might accidentally interact with. The `readonlyField` flag is set by
  // the device-manager aggregator on live fields and on explicitly
  // readonly contributions (rtsp URL, agent assignment, ...).
  if ('readonlyField' in field && (field as { readonlyField?: boolean }).readonlyField === true) {
    return (
      <ReadonlyDisplay
        field={field}
        values={values}
        onAction={onAction}
        translationFn={translationFn}
      />
    )
  }

  // Evaluate showWhen via the shared helper so the section renderer can
  // pre-compute the same visibility (used to hide sections that would
  // collapse to zero visible fields).
  if (!isFieldVisible(field, values, allFields)) return null

  const rawValue = values[field.key]
  const value = rawValue !== undefined ? rawValue : 'default' in field ? field.default : undefined
  const handleChange = (v: unknown) => onChange(field.key, v)

  // Custom-renderer dispatch — host apps register components for field
  // types ui-library doesn't natively render (e.g. `pipeline-editor`,
  // `zone-editor`). Hook fires unconditionally; only consulted on the
  // default branch so built-in cases retain priority.
  const customRenderer = useCustomFieldRenderer(field.type)

  switch (field.type) {
    case 'text':
      return (
        <KeychainOr
          field={field}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        >
          <TextField
            field={field}
            value={value}
            onChange={handleChange}
            disabled={disabled}
            translationFn={translationFn}
          />
        </KeychainOr>
      )
    case 'number':
      return (
        <NumberField
          field={field}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'boolean':
      return (
        <BooleanField
          field={field}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'select':
      return (
        <SelectField
          field={field}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'multiselect':
      return (
        <MultiSelectField
          field={field}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'timezone':
      return (
        <TimezoneField
          field={field}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'datetime':
      return (
        <DateTimeField
          field={field}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'password':
      return (
        <KeychainOr
          field={field}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        >
          <PasswordField
            field={field}
            value={value}
            onChange={handleChange}
            disabled={disabled}
            translationFn={translationFn}
          />
        </KeychainOr>
      )
    case 'textarea':
      return (
        <KeychainOr
          field={field}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
          multiline
        >
          <TextAreaField
            field={field}
            value={value}
            onChange={handleChange}
            disabled={disabled}
            translationFn={translationFn}
          />
        </KeychainOr>
      )
    case 'slider':
      return (
        <SliderField
          field={field}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'tags':
      return (
        <TagsField
          field={field}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'color':
      return (
        <ColorField
          field={field}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'icon':
      return (
        <IconField
          field={field}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'node-select':
      return (
        <NodeSelectField
          field={field as ConfigNodeSelectField}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'node-multiselect':
      return (
        <NodeMultiSelectField
          field={field as ConfigNodeMultiSelectField}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'device-select':
      return (
        <DeviceSelectField
          field={field as ConfigDeviceSelectField}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'device-multiselect':
      return (
        <DeviceMultiSelectField
          field={field as ConfigDeviceMultiSelectField}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'notification-target-select':
      return (
        <ConfigNotificationTargetSelectFieldView
          field={field as ConfigNotificationTargetSelectField}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'notification-target-multiselect':
      return (
        <ConfigNotificationTargetMultiSelectFieldView
          field={field as ConfigNotificationTargetMultiSelectField}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
        />
      )
    case 'probe':
      return (
        <ProbeField
          field={field}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
          onTestField={onTestField}
          onAction={onAction}
          externalProbe={externalProbe}
        />
      )
    case 'group':
      return (
        <GroupField
          field={field}
          values={values}
          onChange={onChange}
          onChangeMany={onChangeMany}
          disabled={disabled}
          translationFn={translationFn}
          onTestField={onTestField}
          onAction={onAction}
        />
      )
    case 'sub-tabs':
      return (
        <SubTabsField
          field={field}
          values={values}
          onChange={onChange}
          disabled={disabled}
          translationFn={translationFn}
          onTestField={onTestField}
          onAction={onAction}
        />
      )
    case 'separator':
      return <SeparatorField />
    case 'info':
      return <InfoBox field={field} />
    case 'qr-code':
      return <QrCodeBox field={field} />
    case 'object-array':
      return <ObjectArrayField field={field} />
    case 'editable-array':
      return (
        <EditableArrayField
          field={field}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          translationFn={translationFn}
          onTestField={onTestField}
          onAction={onAction}
        />
      )
    case 'button':
      return <ButtonField field={field} disabled={disabled} onAction={onAction} />
    case 'addon-action-select': {
      const storedKey = field.writesKey ?? field.key
      return (
        <AddonActionSelectField
          field={field}
          value={values[storedKey]}
          values={values}
          onChange={(next) => onChange(storedKey, next)}
          disabled={disabled}
          onAction={onAction}
        />
      )
    }
    case 'addon-action-button':
      return (
        <AddonActionButtonField
          field={field}
          values={values}
          disabled={disabled}
          onAction={onAction}
          onChange={onChange}
          onChangeMany={onChangeMany}
        />
      )
    case 'account-sign-in':
      return (
        <AccountSignInField
          field={field}
          values={values}
          disabled={disabled}
          onAction={onAction}
          onChangeMany={onChangeMany}
        />
      )
    case 'secret-presence':
      return <SecretPresenceField field={field} values={values} />
    case 'device-action-button':
      return (
        <DeviceActionButtonField
          field={field}
          values={values}
          disabled={disabled}
          onAction={onAction}
        />
      )
    case 'widget':
      return <WidgetField field={field} />
    default: {
      if (customRenderer) {
        const Renderer = customRenderer
        return <Renderer field={field} value={value} onChange={handleChange} disabled={disabled} />
      }
      return null
    }
  }
}

// Backwards-compatible alias — the admin-ui FormBuilder used to
// `import { FormField } from './FormField'`. After consolidation
// it imports `FormField` from `@camstack/ui-library`; the original
// `ConfigFormField` name is the stable canonical export, but `FormField`
// is exported here to ease the migration without renaming every call site.
export { FormField as ConfigFormField }
