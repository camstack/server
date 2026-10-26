import { useUiText } from '../../contexts/ui-text'
import { useState, type ReactNode } from 'react'
import { useDeviceCapability } from '../../hooks/use-device-capability.js'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice.js'
import { cn } from '../../lib/cn.js'
import { formatNumeric } from '../../lib/format-numeric.js'
import {
  formatControlDateTime,
  type ControlDateTimeFormat,
} from '../../lib/format-control-datetime.js'
import type { ControlPanelProps } from './types.js'
import type { ControlStatus } from '@camstack/types'

// ── Datetime input normalization helpers ──────────────────────────────────────
//
// The `control` slice keeps the HA-native value verbatim:
//   - date.*     → 'YYYY-MM-DD'
//   - time.*     → 'HH:MM:SS'
//   - datetime.* → full ISO ('YYYY-MM-DDTHH:MM:SS[.sss][±zz]')
// The browser `<input>` value shapes are narrower:
//   - type=date           → 'YYYY-MM-DD'
//   - type=time           → 'HH:MM'
//   - type=datetime-local → 'YYYY-MM-DDTHH:MM'
// These pure helpers trim the HA-native value to the input shape. They are
// permissive: a malformed value is returned unchanged so the input simply
// renders empty rather than throwing.

/** Trim an HA date value to the `<input type=date>` shape ('YYYY-MM-DD'). */
export function toDateInput(value: string): string {
  return value.slice(0, 10)
}

/** Trim an HA time value ('HH:MM:SS') to the `<input type=time>` shape ('HH:MM'). */
export function toTimeInput(value: string): string {
  return value.slice(0, 5)
}

/** Trim an HA datetime value to the `<input type=datetime-local>` shape
 *  ('YYYY-MM-DDTHH:MM'). Accepts both 'T'- and space-separated forms. */
export function toDateTimeInput(value: string): string {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  return normalized.slice(0, 16)
}

// ── Numeric sub-widget ────────────────────────────────────────────────────────

interface NumericControlProps {
  readonly value: number
  readonly busy: boolean
  readonly onCommit: (v: number) => void
  readonly unit?: string
  readonly min?: number
  readonly max?: number
  readonly step?: number
  /** Suggested decimal places for display. When present, the committed value and
   *  stepper output are formatted with `value.toFixed(precision)`. Does not
   *  constrain the stored value — display only. */
  readonly precision?: number
}

function NumericControl({
  value,
  busy,
  onCommit,
  unit,
  min,
  max,
  step,
  precision,
}: NumericControlProps): ReactNode {
  const t = useUiText()
  const [draft, setDraft] = useState<string>(formatNumeric(value, precision))

  const draftNum = Number(draft)
  const valid = draft !== '' && !Number.isNaN(draftNum)
  const effectiveStep = step ?? 1

  const clamp = (n: number): number => {
    let result = n
    if (min !== undefined) result = Math.max(min, result)
    if (max !== undefined) result = Math.min(max, result)
    return result
  }

  const commit = (): void => {
    if (!busy && valid) onCommit(clamp(draftNum))
  }

  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-label={t('uiLibrary.controlPanel.decrement', 'Decrement')}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          if (!busy) {
            const next = clamp(value - effectiveStep)
            setDraft(formatNumeric(next, precision))
            onCommit(next)
          }
        }}
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded border border-border bg-surface text-xs transition-colors hover:bg-surface-hover',
          busy && 'opacity-40 cursor-not-allowed',
        )}
      >
        −
      </button>
      <input
        aria-label={t('uiLibrary.controlPanel.numeric', 'Numeric value')}
        type="number"
        disabled={busy}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          const parsed = Number(e.target.value)
          if (e.target.value !== '' && !Number.isNaN(parsed)) {
            if (!busy) onCommit(clamp(parsed))
          }
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        className={cn(
          'w-16 rounded border border-border bg-surface px-1 py-0.5 text-xs tabular-nums text-center',
          busy && 'opacity-40 cursor-not-allowed',
        )}
      />
      {unit !== undefined && <span className="text-foreground-subtle text-xs">{unit}</span>}
      <button
        type="button"
        aria-label={t('uiLibrary.controlPanel.increment', 'Increment')}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          if (!busy) {
            const next = clamp(value + effectiveStep)
            setDraft(formatNumeric(next, precision))
            onCommit(next)
          }
        }}
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded border border-border bg-surface text-xs transition-colors hover:bg-surface-hover',
          busy && 'opacity-40 cursor-not-allowed',
        )}
      >
        +
      </button>
    </div>
  )
}

// ── Text sub-widget ───────────────────────────────────────────────────────────

interface TextControlProps {
  readonly value: string
  readonly busy: boolean
  readonly onCommit: (v: string) => void
}

function TextControl({ value, busy, onCommit }: TextControlProps): ReactNode {
  const [draft, setDraft] = useState(value)

  return (
    <input
      type="text"
      disabled={busy}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (!busy) onCommit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !busy) onCommit(draft)
      }}
      className={cn(
        'rounded border border-border bg-surface px-2 py-0.5 text-xs',
        busy && 'opacity-40 cursor-not-allowed',
      )}
    />
  )
}

// ── ControlPanel ──────────────────────────────────────────────────────────────

/** Callback type accepted by the `control` cap's `setValue` method (device-id
 *  is injected by the proxy; callers only supply the discriminated union). */
type SetValueFn = (input: { control: ControlSetValueArg }) => void

type ControlSetValueArg =
  | { kind: 'numeric'; value: number }
  | { kind: 'select'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'datetime'; value: string }

/** Renders the correct input widget for the slice's `kind`. Exhaustive switch
 *  ensures TypeScript will error if a new ControlKind is added without adding
 *  a branch here. No casts — each branch narrows `slice.kind` to a literal and
 *  the `control` argument is structurally typed per branch. */
interface ControlWidgetProps {
  readonly slice: ControlStatus
  readonly busy: boolean
  readonly setValueFn: SetValueFn
  /** Row readout (compact) vs editable detail (full). The datetime kind renders
   *  a read-only locale-formatted span in `compact` and the editable native
   *  input in `full`. */
  readonly layout: 'compact' | 'full'
}

function ControlWidget({ slice, busy, setValueFn, layout }: ControlWidgetProps): ReactNode {
  const t = useUiText()
  const kind = slice.kind

  switch (kind) {
    case 'numeric': {
      const numericValue = typeof slice.value === 'number' ? slice.value : Number(slice.value)
      return (
        <NumericControl
          value={numericValue}
          busy={busy}
          onCommit={(v) => {
            setValueFn({ control: { kind: 'numeric', value: v } })
          }}
          min={slice.min}
          max={slice.max}
          step={slice.step}
        />
      )
    }

    case 'select': {
      const selectValue = String(slice.value)
      return (
        <select
          aria-label={t('uiLibrary.controlPanel.value', 'Control value')}
          disabled={busy}
          value={selectValue}
          onChange={(e) => {
            e.stopPropagation()
            if (!busy) setValueFn({ control: { kind: 'select', value: e.target.value } })
          }}
          className={cn(
            // Borderless inside the panel chrome — a second `border-border`
            // here was the double-border on every select preview in the
            // device table. w-full + min-w-0 lets the select shrink to its
            // FILL control column (a native <select>'s intrinsic min-content
            // width is the longest option label + chevron, which otherwise
            // overflows the fixed 140px box onto the trailing status dot);
            // max-w-full + truncate cap and ellipsize the displayed value.
            'w-full max-w-full min-w-0 truncate rounded bg-transparent px-0.5 py-0.5 text-xs',
            busy && 'opacity-40 cursor-not-allowed',
          )}
        >
          {slice.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      )
    }

    case 'text': {
      const textValue = String(slice.value)
      return (
        <TextControl
          value={textValue}
          busy={busy}
          onCommit={(v) => {
            setValueFn({ control: { kind: 'text', value: v } })
          }}
        />
      )
    }

    case 'datetime': {
      const rawValue = String(slice.value)
      const format: ControlDateTimeFormat = 'datetime'

      // Read-only (at-a-glance) context: render the value in the user's locale
      // instead of an editable input. Editing stays in the full/detail layout.
      if (layout === 'compact') {
        if (rawValue === '') {
          return (
            <span
              aria-label={t('uiLibrary.controlPanel.value', 'Control value')}
              className="text-xs text-foreground-subtle"
            >
              —
            </span>
          )
        }
        return (
          <span
            aria-label={t('uiLibrary.controlPanel.value', 'Control value')}
            className="text-xs text-foreground"
          >
            {formatControlDateTime(rawValue, format)}
          </span>
        )
      }

      const inputType = format === 'date' ? 'date' : format === 'time' ? 'time' : 'datetime-local'
      const inputValue =
        format === 'date'
          ? toDateInput(rawValue)
          : format === 'time'
            ? toTimeInput(rawValue)
            : toDateTimeInput(rawValue)
      return (
        <input
          type={inputType}
          aria-label={t('uiLibrary.controlPanel.value', 'Control value')}
          disabled={busy}
          value={inputValue}
          onChange={(e) => {
            e.stopPropagation()
            // Emit the input value as-is — the device normalizes HA-native
            // shapes (e.g. appends seconds for `time`).
            if (!busy) setValueFn({ control: { kind: 'datetime', value: e.target.value } })
          }}
          className={cn(
            'rounded border border-border bg-surface px-1 py-0.5 text-xs',
            busy && 'opacity-40 cursor-not-allowed',
          )}
        />
      )
    }

    default: {
      // Exhaustive guard — will fail to compile if a new ControlKind variant
      // is added without a corresponding case above.
      kind satisfies never
      return null
    }
  }
}

export function ControlPanel({
  trpc,
  deviceId,
  features: _features,
  layout,
  optimistic,
}: ControlPanelProps): ReactNode {
  const { cap, slice, available } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.control,
    slice: (d) => d.state.control,
  })

  const { display, applyOptimistic } = useOptimisticSlice<ControlStatus>(slice, {
    enabled: optimistic ?? true,
  })

  if (display === undefined) return null

  const busy = !available

  const setValueFn: SetValueFn = (input) => {
    if (!busy && cap) {
      // Apply optimistic patch — the value field maps to control.value
      applyOptimistic({ value: input.control.value })
      void cap.setValue(input)
    }
  }

  return (
    <div
      data-kind={display.kind}
      // min-w-0 / max-w-full let the panel (and its select child) shrink within
      // the FILL control column instead of overflowing the fixed 140px box.
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded border border-border px-2 py-1 transition-colors"
    >
      <ControlWidget slice={display} busy={busy} setValueFn={setValueFn} layout={layout} />
    </div>
  )
}
