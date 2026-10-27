/**
 * Project a statistics or integral helper onto a new device (D944 §3).
 * The value field is `series`: the composer fills it from history.
 */
import { DeviceRole, DeviceType } from '../../device/device-type.js'
import { historyFieldsFor } from '../../generated/history-catalog.js'
import type { CompositionFieldSource, CompositionSeriesSource } from '../composition.js'
import type { CompositionProblem } from '../composition-report.js'
import { problem } from '../plan-result.js'
import type { SeriesKind } from './history-math.js'
import {
  DEFAULT_HISTORY_RETENTION,
  type HistoryRetention,
  planResetTier,
  planStatisticTier,
} from './history-window.js'
import type {
  DerivativeHelperSpec,
  HelperMember,
  IntegralHelperSpec,
  StatisticHelperSpec,
} from './spec.js'

const NOW: CompositionFieldSource = { kind: 'expression', expr: 'now', bindings: {} }

function series(
  member: HelperMember,
  publish: CompositionSeriesSource['publish'],
  empty: CompositionSeriesSource['empty'],
): CompositionSeriesSource {
  return {
    kind: 'series',
    read: { source: member.source, cap: member.cap, fieldPath: member.fieldPath },
    publish,
    empty,
  }
}

function counts(member: HelperMember): Record<string, CompositionSeriesSource> {
  return {
    included: series(member, 'included', 'offline'),
    excluded: series(member, 'excluded', 'offline'),
    total: series(member, 'total', 'offline'),
  }
}

const PER_SYMBOL: Readonly<Record<DerivativeHelperSpec['per'], string>> = {
  second: 's',
  minute: 'min',
  hour: 'h',
}

/**
 * The unit of a rate: the source series' unit per second, minute or hour
 * (`°C/h`). A source with no unit of its own (a generic number) has none to
 * borrow, so the label is null and the chart shows the bare number.
 */
export function derivativeUnitLabel(spec: DerivativeHelperSpec): string | null {
  const unit = historyFieldsFor(spec.source.cap)[spec.source.fieldPath]?.unit
  return unit === undefined ? null : `${unit}/${PER_SYMBOL[spec.per]}`
}

export function declaredSeriesKind(member: HelperMember): SeriesKind | 'enum' | null {
  const field = historyFieldsFor(member.cap)[member.fieldPath]
  if (field === undefined) return null
  return field.kind
}

function historyProblems(member: HelperMember): readonly CompositionProblem[] {
  if (declaredSeriesKind(member) !== null) return []
  return [
    problem(
      'member-constraint',
      'helper.source',
      `${member.cap}.${member.fieldPath} has no history declaration`,
    ),
  ]
}

function draft(input: {
  readonly role: DeviceRole
  readonly cap: string
  readonly field: string
  readonly empty: CompositionSeriesSource['empty']
  readonly spec: StatisticHelperSpec | IntegralHelperSpec | DerivativeHelperSpec
  readonly member: HelperMember
}): unknown {
  return {
    target: { kind: 'new', type: DeviceType.Sensor, role: input.role },
    helper: input.spec,
    features: [
      {
        kind: 'fields',
        cap: input.cap,
        fields: {
          [input.field]: series(input.member, 'value', input.empty),
          lastFetchedAt: NOW,
        },
      },
      { kind: 'fields', cap: 'group-status', fields: counts(input.member) },
    ],
  }
}

export function statisticDraft(
  spec: StatisticHelperSpec,
  retention: HistoryRetention = DEFAULT_HISTORY_RETENTION,
): { readonly draft: unknown; readonly problems: readonly CompositionProblem[] } {
  const problems = [...historyProblems(spec.source)]
  const kind = declaredSeriesKind(spec.source)
  if (kind === 'enum') {
    problems.push(
      problem(
        'kind-mismatch',
        'helper.source',
        'a statistic reads a number or a boolean, not a state',
      ),
    )
  }
  if (spec.stat === 'sum' && kind !== 'counter') {
    problems.push(
      problem('kind-mismatch', 'helper.stat', 'a gauge has no sum — that is the integral template'),
    )
  }
  const tier = planStatisticTier(spec.window, retention)
  if (!tier.ok) problems.push(problem('retention', 'helper.window', tier.reason))
  return {
    problems,
    draft: draft({
      role: DeviceRole.NumericSensor,
      cap: 'numeric-sensor',
      field: 'value',
      empty: 'null',
      spec,
      member: spec.source,
    }),
  }
}

/**
 * A derivative reads a gauge or a counter and publishes its rate per second,
 * minute or hour. The output is a plain number: a rate of a temperature is not
 * a temperature, so the chart carries no inherited unit.
 */
export function derivativeDraft(
  spec: DerivativeHelperSpec,
  retention: HistoryRetention = DEFAULT_HISTORY_RETENTION,
): { readonly draft: unknown; readonly problems: readonly CompositionProblem[] } {
  const problems = [...historyProblems(spec.source)]
  const kind = declaredSeriesKind(spec.source)
  if (kind === 'enum' || kind === 'boolean') {
    problems.push(
      problem(
        'kind-mismatch',
        'helper.source',
        'a derivative reads a number that moves, not a yes/no or a state',
      ),
    )
  }
  const tier = planStatisticTier(spec.window, retention)
  if (!tier.ok) problems.push(problem('retention', 'helper.window', tier.reason))
  return {
    problems,
    draft: draft({
      role: DeviceRole.NumericSensor,
      cap: 'numeric-sensor',
      field: 'value',
      empty: 'null',
      spec,
      member: spec.source,
    }),
  }
}

export function integralDraft(
  spec: IntegralHelperSpec,
  retention: HistoryRetention = DEFAULT_HISTORY_RETENTION,
): { readonly draft: unknown; readonly problems: readonly CompositionProblem[] } {
  const problems = [...historyProblems(spec.source)]
  const kind = declaredSeriesKind(spec.source)
  const watts = spec.source.cap === 'power-meter' && spec.source.fieldPath === 'watts'
  if (kind === 'counter' || kind === 'boolean' || kind === 'enum') {
    problems.push(
      problem(
        'kind-mismatch',
        'helper.source',
        'an integral reads an instantaneous gauge, not a counter or a state',
      ),
    )
  }
  if (spec.output === 'energy' && !watts) {
    problems.push(
      problem(
        'kind-mismatch',
        'helper.output',
        'energy is the integral of power-meter.watts; another reading uses the meter',
      ),
    )
  }
  if (spec.output === 'meter' && watts) {
    problems.push(
      problem(
        'kind-mismatch',
        'helper.output',
        'power integrates to power-meter.kwhTotal, which energy dashboards already read',
      ),
    )
  }
  const tier = planResetTier(spec.reset, retention)
  if (!tier.ok) problems.push(problem('retention', 'helper.reset', tier.reason))
  const energy = spec.output === 'energy'
  return {
    problems,
    draft: draft({
      role: energy ? DeviceRole.EnergySensor : DeviceRole.NumericSensor,
      cap: energy ? 'power-meter' : 'meter',
      field: energy ? 'kwhTotal' : 'value',
      empty: 'offline',
      spec,
      member: spec.source,
    }),
  }
}
