import {
  controlCapability,
  type DeviceContext,
  type InferNativeProvider,
  type ControlStatus,
  type ControlKind,
  type DeviceRole,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

/**
 * HA-backed user-input control. One cap (`control`) hosts every
 * variant — the discriminator is the `kind` field on the slice +
 * setValue input. Domain mapping:
 *   - number / input_number   → kind='numeric',  service set_value({value})
 *   - select / input_select   → kind='select',   service select_option({option})
 *   - text / input_text       → kind='text',     service set_value({value})
 *   - date                    → kind='datetime', format='date',     set_value({date})
 *   - time                    → kind='datetime', format='time',     set_value({time})
 *   - datetime                → kind='datetime', format='datetime', set_value({datetime})
 *   - input_datetime          → kind='datetime', format derived from
 *                               has_date/has_time, service set_datetime({datetime})
 *
 * The datetime `value` is kept as the HA-native string (date.* → 'YYYY-MM-DD',
 * time.* → 'HH:MM:SS', datetime.* → full ISO). The UI widget normalizes to/from
 * the `<input>` value shape; the device passes HA-native strings to/from the
 * service (for `time` set_value, ':00' seconds are appended when absent).
 */
export class HaControlDevice extends HaBaseChildDevice {
  private readonly kind: ControlKind
  private readonly haDomain: string

  constructor(ctx: DeviceContext) {
    const persisted = (ctx.persistedConfig ?? {}) as {
      role?: DeviceRole
      entityId?: string
      options?: unknown
    }
    super(ctx, persisted.role !== undefined ? { role: persisted.role } : {})
    this.haDomain = (persisted.entityId ?? '').split('.')[0] ?? ''
    this.kind = roleToKind(persisted.role)
    const seedOptions: string[] = Array.isArray(persisted.options)
      ? (persisted.options as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
    this.registerControlCap()
    this.runtimeState.setCapState('control', {
      kind: this.kind,
      value: this.kind === 'numeric' ? 0 : '',
      options: seedOptions,
      lastChangedAt: 0,
      ...(this.kind === 'datetime' ? { format: this.datetimeFormat(undefined) } : {}),
    })
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const lastChangedAt = Date.parse(state.last_changed) || Date.now()
    const slice = decodeControlSlice(this.kind, state, lastChangedAt, () =>
      this.datetimeFormat(state.attributes),
    )
    if (slice !== null) this.runtimeState.setCapState('control', slice)
  }

  private registerControlCap(): void {
    const provider: InferNativeProvider<typeof controlCapability> = {
      getStatus: async () => {
        return (
          this.runtimeState.getCapState<ControlStatus>('control') ?? {
            kind: this.kind,
            value: this.kind === 'numeric' ? 0 : '',
            options: [],
            lastChangedAt: 0,
            ...(this.kind === 'datetime' ? { format: this.datetimeFormat(undefined) } : {}),
          }
        )
      },
      setValue: async ({ control }) => {
        await this.dispatchSet(control)
      },
    }
    this.ctx.registerNativeCap(controlCapability, provider)
  }

  /**
   * Resolve the datetime sub-format from the device's HA domain. For
   * `input_datetime` the format is derived per-push from the entity's
   * `has_date` / `has_time` attributes (both → 'datetime', date-only →
   * 'date', time-only → 'time', default 'datetime').
   */
  private datetimeFormat(attributes: Record<string, unknown> | undefined): DateTimeFormat {
    switch (this.haDomain) {
      case 'date':
        return 'date'
      case 'time':
        return 'time'
      case 'datetime':
        return 'datetime'
      case 'input_datetime': {
        const hasDate = attributes?.['has_date'] === true
        const hasTime = attributes?.['has_time'] === true
        if (hasDate && hasTime) return 'datetime'
        if (hasDate) return 'date'
        if (hasTime) return 'time'
        return 'datetime'
      }
      default:
        return 'datetime'
    }
  }

  private async dispatchSet(
    control:
      | { kind: 'numeric'; value: number }
      | { kind: 'select'; value: string }
      | { kind: 'text'; value: string }
      | { kind: 'datetime'; value: string },
  ): Promise<void> {
    switch (control.kind) {
      case 'numeric':
        await this.callHaService(this.haDomain, 'set_value', { value: control.value })
        return
      case 'select':
        await this.callHaService(this.haDomain, 'select_option', { option: control.value })
        return
      case 'text':
        await this.callHaService(this.haDomain, 'set_value', { value: control.value })
        return
      case 'datetime':
        await this.dispatchDatetime(control.value)
        return
    }
  }

  /** Route a datetime value to the correct HA service per the entity domain.
   *  Each native `date.*` / `time.* `/ `datetime.*` entity has its own
   *  `set_value` field name; `input_datetime` keeps the legacy `set_datetime`. */
  private async dispatchDatetime(value: string): Promise<void> {
    switch (this.haDomain) {
      case 'date':
        await this.callHaService('date', 'set_value', { date: value })
        return
      case 'time':
        // HA `time.*` set_value expects 'HH:MM:SS'; the UI emits 'HH:MM'.
        await this.callHaService('time', 'set_value', { time: ensureSeconds(value) })
        return
      case 'datetime':
        await this.callHaService('datetime', 'set_value', { datetime: value })
        return
      case 'input_datetime':
        await this.callHaService('input_datetime', 'set_datetime', { datetime: value })
        return
      default:
        await this.callHaService(this.haDomain, 'set_datetime', { datetime: value })
        return
    }
  }
}

type DateTimeFormat = 'date' | 'time' | 'datetime'

/** Append ':00' seconds to an 'HH:MM' value when seconds are absent. Leaves
 *  an already-seconds value untouched. */
function ensureSeconds(value: string): string {
  const parts = value.split(':')
  return parts.length === 2 ? `${value}:00` : value
}

function roleToKind(role: DeviceRole | undefined): ControlKind {
  switch (role) {
    case 'numeric-control':
      return 'numeric'
    case 'select-control':
      return 'select'
    case 'text-control':
      return 'text'
    case 'datetime-control':
      return 'datetime'
    default:
      return 'text'
  }
}

/**
 * Derive display precision from a numeric step value when HA does not provide
 * `suggested_display_precision` explicitly. Returns the number of decimal
 * places implied by the step granularity (e.g. 0.5 → 1, 0.01 → 2, 1 → 0).
 * Returns `undefined` when step is absent or is a whole number (let the UI
 * apply its own auto-formatting for integer steps).
 */
export function precisionFromStep(step: number | undefined): number | undefined {
  if (step === undefined || step <= 0) return undefined
  if (Number.isInteger(step)) return 0
  const str = step.toString()
  const dotIndex = str.indexOf('.')
  if (dotIndex === -1) return 0
  return str.length - dotIndex - 1
}

function decodeControlSlice(
  kind: ControlKind,
  state: HaEntityState,
  lastChangedAt: number,
  resolveFormat: () => DateTimeFormat,
): ControlStatus | null {
  switch (kind) {
    case 'numeric': {
      const v = Number(state.state)
      if (!Number.isFinite(v)) return null
      const rawUnit = state.attributes['unit_of_measurement']
      const rawMin = state.attributes['min']
      const rawMax = state.attributes['max']
      const rawStep = state.attributes['step']
      const rawPrecision = state.attributes['suggested_display_precision']
      const unit = typeof rawUnit === 'string' && rawUnit.length > 0 ? rawUnit : undefined
      const min = typeof rawMin === 'number' && Number.isFinite(rawMin) ? rawMin : undefined
      const max = typeof rawMax === 'number' && Number.isFinite(rawMax) ? rawMax : undefined
      const step =
        typeof rawStep === 'number' && Number.isFinite(rawStep) && rawStep > 0 ? rawStep : undefined
      // Use HA's explicit precision when provided; fall back to step-derived precision.
      const precision =
        typeof rawPrecision === 'number' && Number.isFinite(rawPrecision)
          ? rawPrecision
          : precisionFromStep(step)
      return {
        kind: 'numeric',
        value: v,
        options: [],
        lastChangedAt,
        unit,
        min,
        max,
        step,
        precision,
      }
    }
    case 'select': {
      const options = Array.isArray(state.attributes['options'])
        ? (state.attributes['options'] as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          )
        : []
      return { kind: 'select', value: state.state, options, lastChangedAt }
    }
    case 'text': {
      return { kind: 'text', value: state.state, options: [], lastChangedAt }
    }
    case 'datetime': {
      return {
        kind: 'datetime',
        value: state.state,
        options: [],
        lastChangedAt,
        format: resolveFormat(),
      }
    }
  }
}
