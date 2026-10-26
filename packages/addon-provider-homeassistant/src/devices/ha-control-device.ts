import {
  controlCapability,
  quantityFromUnit,
  tryConvertDelta,
  tryConvertUnit,
  baseUnitOf,
  normalizeUnit,
  type DeviceContext,
  type InferNativeProvider,
  type ControlStatus,
  type ControlKind,
  type DeviceRole,
  type IScopedLogger,
  type ReadingQuantity,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import { takeReading } from '../ha-reading.js'
import type { HaEntityState } from '../ha-types.js'

/**
 * HA-backed user-input control. One cap (`control`) hosts every
 * variant — the discriminator is the `kind` field on the slice +
 * setValue input. Domain mapping:
 *   - number / input_number   → kind='numeric',  service set_value({value})
 *   - select / input_select   → kind='select',   service select_option({option})
 *   - text / input_text       → kind='text',     service set_value({value})
 *   - date                    → kind='datetime', shape date,     set_value({date})
 *   - time                    → kind='datetime', shape time,     set_value({time})
 *   - datetime                → kind='datetime', shape datetime, set_value({datetime})
 *   - input_datetime          → kind='datetime', shape derived from
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
  /** Unit the upstream entity speaks. Writes convert the base value back to it. */
  private upstreamUnit: string | undefined

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
    if (this.kind === 'datetime') {
      void this.updateSourceInfo({ dateTimeShape: this.datetimeFormat(undefined) })
    }
    this.runtimeState.setCapState('control', {
      kind: this.kind,
      value: this.kind === 'numeric' ? 0 : '',
      options: seedOptions,
      lastChangedAt: 0,
    })
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const lastChangedAt = Date.parse(state.last_changed) || Date.now()
    const slice = decodeControlSlice(this.kind, state, lastChangedAt, {
      logger: this.deviceLogger,
      deviceId: this.id,
      quantity: this.sourceInfo.quantity,
      note: (quantity, unit) => {
        this.upstreamUnit = unit
        if (this.sourceInfo.quantity !== quantity) void this.updateSourceInfo({ quantity })
      },
      noteShape: (shape) => {
        if (this.sourceInfo.dateTimeShape !== shape) {
          void this.updateSourceInfo({ dateTimeShape: shape })
        }
      },
      shape: () => this.datetimeFormat(state.attributes),
    })
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

  /** Base-unit value → the unit the upstream entity still speaks. */
  private toUpstream(value: number): number | null {
    const quantity = this.sourceInfo.quantity
    const base = quantity === undefined ? undefined : baseUnitOf(quantity)
    const upstream = this.upstreamUnit
    if (base === undefined || upstream === undefined || upstream === base) return value
    const converted = tryConvertUnit(value, base, upstream)
    if (converted !== undefined) return converted
    this.deviceLogger.warn('numeric reading refused', {
      tags: { deviceId: this.id },
      meta: { quantity: quantity ?? 'device', unit: upstream, reason: 'unknown-unit' },
    })
    return null
  }

  private async dispatchSet(
    control:
      | { kind: 'numeric'; value: number }
      | { kind: 'select'; value: string }
      | { kind: 'text'; value: string }
      | { kind: 'datetime'; value: string },
  ): Promise<void> {
    switch (control.kind) {
      case 'numeric': {
        const outbound = this.toUpstream(control.value)
        if (outbound === null) return
        await this.callHaService(this.haDomain, 'set_value', { value: outbound })
        return
      }
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

interface ControlDecode {
  readonly logger: IScopedLogger
  readonly deviceId: number
  readonly quantity: ReadingQuantity | undefined
  note(quantity: ReadingQuantity, upstreamUnit: string | undefined): void
  noteShape(shape: DateTimeFormat): void
  shape(): DateTimeFormat
}

function decodeControlSlice(
  kind: ControlKind,
  state: HaEntityState,
  lastChangedAt: number,
  decode: ControlDecode,
): ControlStatus | null {
  switch (kind) {
    case 'numeric':
      return decodeNumeric(state, lastChangedAt, decode)
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
      decode.noteShape(decode.shape())
      return { kind: 'datetime', value: state.state, options: [], lastChangedAt }
    }
  }
}

function decodeNumeric(
  state: HaEntityState,
  lastChangedAt: number,
  decode: ControlDecode,
): ControlStatus | null {
  const v = Number(state.state)
  if (!Number.isFinite(v)) return null
  const rawUnit = state.attributes['unit_of_measurement']
  const unit = typeof rawUnit === 'string' && rawUnit.length > 0 ? rawUnit : undefined
  const incoming = unit === undefined ? undefined : quantityFromUnit(unit)
  if (unit !== undefined && (incoming === undefined || incoming === 'device')) {
    decode.logger.warn('numeric reading refused', {
      tags: { deviceId: decode.deviceId },
      meta: { quantity: 'device', unit, reason: 'unknown-unit' },
    })
    return null
  }
  const stored = decode.quantity
  const quantity = stored !== undefined && stored !== 'device' ? stored : (incoming ?? 'none')
  if (incoming !== undefined && incoming !== 'device' && incoming !== quantity) {
    decode.logger.warn('numeric reading refused', {
      tags: { deviceId: decode.deviceId },
      meta: { quantity, unit: unit ?? '', reason: 'cross-dimension' },
    })
    return null
  }
  const value = takeReading(decode.logger, decode.deviceId, v, unit, quantity)
  if (value === null) return null
  decode.note(quantity, unit === undefined ? undefined : normalizeUnit(unit))
  const rawMin = state.attributes['min']
  const rawMax = state.attributes['max']
  const rawStep = state.attributes['step']
  const min =
    typeof rawMin === 'number'
      ? takeReading(decode.logger, decode.deviceId, rawMin, unit, quantity)
      : undefined
  const max =
    typeof rawMax === 'number'
      ? takeReading(decode.logger, decode.deviceId, rawMax, unit, quantity)
      : undefined
  const stepRaw = typeof rawStep === 'number' && rawStep > 0 ? rawStep : undefined
  const step = convertStep(stepRaw, unit, quantity)
  return {
    kind: 'numeric',
    value,
    options: [],
    lastChangedAt,
    ...(min !== undefined && min !== null ? { min } : {}),
    ...(max !== undefined && max !== null ? { max } : {}),
    ...(step !== undefined ? { step } : {}),
  }
}

/** A step is a difference: °F's offset must not move it. */
function convertStep(
  step: number | undefined,
  unit: string | undefined,
  quantity: ReadingQuantity,
): number | undefined {
  if (step === undefined) return undefined
  const base = baseUnitOf(quantity)
  const from = unit === undefined ? undefined : normalizeUnit(unit)
  if (base === undefined || from === undefined || from === base) return step
  return tryConvertDelta(step, from, base)
}
