/**
 * Project a helper spec onto the composition the composer already runs (D944).
 * Pure: it stores nothing. A group does not compile to `avg(...)` / `any(...)`.
 */
import { DeviceType } from '../../device/device-type.js'
import { dwellExpr, unsignedToken } from '../customize/scalar-expr.js'
import {
  type Composition,
  type CompositionAggregateSource,
  type CompositionFieldRead,
  type CompositionFieldSource,
  CompositionSchema,
  type CompositionSourceRef,
} from '../composition.js'
import type { CompositionProblem } from '../composition-report.js'
import { problem } from '../plan-result.js'
import { reducerForActive } from './actuator.js'
import { applianceDeviceType } from './appliance.js'
import { type GroupTemplate, groupTemplate } from './catalog.js'
import { derivativeDraft, integralDraft, statisticDraft } from './compile-history.js'
import { arithmeticDraft, expressionDraft, thresholdDraft } from './compile-math.js'
import { DEFAULT_HISTORY_RETENTION, type HistoryRetention } from './history-window.js'
import {
  type ApplianceHelperSpec,
  type GroupHelperSpec,
  type HelperMember,
  type HelperSpec,
} from './spec.js'

export interface HelperCompiled {
  readonly ok: true
  readonly composition: Composition
}

export interface HelperRefused {
  readonly ok: false
  readonly problems: readonly CompositionProblem[]
}

export type HelperCompileResult = HelperCompiled | HelperRefused

function sameSource(a: CompositionSourceRef, b: CompositionSourceRef): boolean {
  return a.addonId === b.addonId && a.stableId === b.stableId
}

function sameMember(a: HelperMember, b: HelperMember): boolean {
  return sameSource(a.source, b.source) && a.cap === b.cap && a.fieldPath === b.fieldPath
}

function accepted(template: GroupTemplate, member: HelperMember): boolean {
  return template.accept.some(
    (field) => field.cap === member.cap && field.fieldPath === member.fieldPath,
  )
}

function memberProblems(
  template: GroupTemplate,
  spec: GroupHelperSpec,
): readonly CompositionProblem[] {
  return spec.members.flatMap((member, index) => {
    const at = `helper.members[${index}]`
    const problems: CompositionProblem[] = []
    if (!accepted(template, member)) {
      const allowed = template.accept.map((field) => `${field.cap}.${field.fieldPath}`).join(' or ')
      problems.push(
        problem(
          'member-constraint',
          at,
          `a ${template.id} group reads ${allowed}; this member is ${member.cap}.${member.fieldPath}`,
        ),
      )
    }
    const earlier = spec.members.slice(0, index).some((other) => sameMember(other, member))
    if (earlier)
      problems.push(problem('member-constraint', at, 'this member is already in the group'))
    return problems
  })
}

function aggregateSource(
  template: GroupTemplate,
  spec: GroupHelperSpec,
  reads: readonly CompositionFieldRead[],
  publish: CompositionAggregateSource['publish'],
): CompositionAggregateSource {
  return {
    kind: 'aggregate',
    reducer: spec.aggregate,
    reads: [...reads],
    publish,
    empty: template.empty,
    ...(template.activeWhen === undefined ? {} : { activeWhen: [...template.activeWhen] }),
  }
}

function draftOf(template: GroupTemplate, spec: GroupHelperSpec): unknown {
  const reads: CompositionFieldRead[] = spec.members.map((member) => ({
    source: member.source,
    cap: member.cap,
    fieldPath: member.fieldPath,
  }))
  const companions = Object.fromEntries(
    template.companions.map((companion) => [companion.fieldPath, expressionSource(companion.expr)]),
  )
  return {
    target: {
      kind: 'new',
      type: template.deviceType,
      ...(template.role === undefined ? {} : { role: template.role }),
    },
    helper: spec,
    features: [
      {
        kind: 'fields',
        cap: template.outputCap,
        fields: {
          [template.outputField]: aggregateSource(template, spec, reads, 'value'),
          ...companions,
        },
      },
      {
        kind: 'fields',
        cap: 'group-status',
        fields: {
          included: aggregateSource(template, spec, reads, 'included'),
          excluded: aggregateSource(template, spec, reads, 'excluded'),
          total: aggregateSource(template, spec, reads, 'total'),
        },
      },
    ],
  }
}

function criterionProblems(
  template: GroupTemplate,
  spec: GroupHelperSpec,
): readonly CompositionProblem[] {
  if (template.family === 'actuator') {
    if (spec.active === undefined) {
      return [
        problem(
          'kind-mismatch',
          'helper.active',
          `a ${template.id} group needs an active criterion (at-least-one or all)`,
        ),
      ]
    }
    const reducer = reducerForActive(spec.active)
    if (spec.aggregate !== reducer) {
      return [
        problem(
          'kind-mismatch',
          'helper.aggregate',
          `active \`${spec.active}\` aggregates by \`${reducer}\`, not \`${spec.aggregate}\``,
        ),
      ]
    }
    return []
  }
  if (spec.active !== undefined) {
    return [
      problem(
        'kind-mismatch',
        'helper.active',
        `a ${template.id} group has no active criterion — that belongs to an actuator group`,
      ),
    ]
  }
  return []
}

function parseDraft(draft: unknown): HelperCompileResult {
  const parsed = CompositionSchema.safeParse(draft)
  if (parsed.success) return { ok: true, composition: parsed.data }
  const message = parsed.error.issues.map((issue) => issue.message).join('; ')
  return {
    ok: false,
    problems: [problem('helper-mismatch', 'helper', `the template did not compile: ${message}`)],
  }
}

function expressionSource(
  expr: string,
  bindings: CompositionExpressionBindings = {},
): CompositionFieldSource {
  return { kind: 'expression', expr, bindings }
}

type CompositionExpressionBindings = Extract<
  CompositionFieldSource,
  { kind: 'expression' }
>['bindings']

function compileAppliance(spec: ApplianceHelperSpec): HelperCompileResult {
  const member = spec.member
  if (member.cap !== 'power-meter' || member.fieldPath !== 'power') {
    return {
      ok: false,
      problems: [
        problem(
          'member-constraint',
          'helper.member',
          'an appliance helper reads power-meter.power',
        ),
      ],
    }
  }
  const threshold = unsignedToken(spec.thresholdWatts)
  const start = unsignedToken(spec.startDwellMs)
  const stop = unsignedToken(spec.stopDwellMs)
  if (threshold === null || spec.thresholdWatts <= 0) {
    return {
      ok: false,
      problems: [
        problem(
          'kind-mismatch',
          'helper.thresholdWatts',
          'the threshold is watts above which the appliance is running',
        ),
      ],
    }
  }
  if (start === null || stop === null) {
    return {
      ok: false,
      problems: [
        problem(
          'kind-mismatch',
          'helper.startDwellMs',
          'start and stop dwells are a non-negative number of milliseconds',
        ),
      ],
    }
  }
  const read = {
    kind: 'from' as const,
    source: member.source,
    cap: member.cap,
    fieldPath: member.fieldPath,
  }
  const dwell = dwellExpr('gte', threshold, start, stop)
  const clock = expressionSource('now')
  return parseDraft({
    target: { kind: 'new', type: applianceDeviceType(spec.appliance) },
    helper: spec,
    features: [
      {
        kind: 'fields',
        cap: 'running-state',
        fields: {
          running: expressionSource(dwell, { x: read }),
          source: expressionSource('"assigned"'),
          phase: expressionSource('null'),
          lastFetchedAt: clock,
          since: expressionSource(`latchedAt(${dwell})`, { x: read }),
        },
      },
      {
        kind: 'fields',
        cap: 'power-meter',
        fields: {
          power: read,
          lastFetchedAt: clock,
        },
      },
    ],
  })
}

/** Compile a helper template to a new-device composition. Refusals are named. */
export function compileHelper(
  spec: HelperSpec,
  retention: HistoryRetention = DEFAULT_HISTORY_RETENTION,
): HelperCompileResult {
  switch (spec.kind) {
    case 'group':
      return compileGroup(spec)
    case 'appliance':
      return compileAppliance(spec)
    case 'statistic': {
      const built = statisticDraft(spec, retention)
      if (built.problems.length > 0) return { ok: false, problems: built.problems }
      return parseDraft(built.draft)
    }
    case 'integral': {
      const built = integralDraft(spec, retention)
      if (built.problems.length > 0) return { ok: false, problems: built.problems }
      return parseDraft(built.draft)
    }
    case 'derivative': {
      const built = derivativeDraft(spec, retention)
      if (built.problems.length > 0) return { ok: false, problems: built.problems }
      return parseDraft(built.draft)
    }
    case 'threshold':
      return compileMath(thresholdDraft(spec))
    case 'arithmetic':
      return compileMath(arithmeticDraft(spec))
    case 'expression':
      return compileMath(expressionDraft(spec))
  }
}

function compileMath(built: {
  readonly draft: unknown
  readonly problems: readonly CompositionProblem[]
}): HelperCompileResult {
  if (built.problems.length > 0) return { ok: false, problems: built.problems }
  return parseDraft(built.draft)
}

function compileGroup(spec: GroupHelperSpec): HelperCompileResult {
  const template = groupTemplate(spec.templateId)
  if (template === null) {
    return {
      ok: false,
      problems: [
        problem(
          'member-constraint',
          'helper.templateId',
          `unknown template \`${spec.templateId}\``,
        ),
      ],
    }
  }
  const criterion = criterionProblems(template, spec)
  if (criterion.length > 0) return { ok: false, problems: criterion }
  if (!template.aggregates.includes(spec.aggregate)) {
    const allowed = template.aggregates.join(', ')
    return {
      ok: false,
      problems: [
        problem(
          'kind-mismatch',
          'helper.aggregate',
          `a ${template.id} group aggregates by ${allowed}, not \`${spec.aggregate}\``,
        ),
      ],
    }
  }
  const members = memberProblems(template, spec)
  if (members.length > 0) return { ok: false, problems: members }
  return parseDraft(draftOf(template, spec))
}

/** The built body, ignoring `helper`, so a save can demand one writer. */
export function sameHelperBody(stored: Composition, compiled: Composition): boolean {
  return (
    JSON.stringify(stored.target) === JSON.stringify(compiled.target) &&
    JSON.stringify(stored.features) === JSON.stringify(compiled.features)
  )
}

export function templateDeviceType(spec: HelperSpec): DeviceType | null {
  if (spec.kind === 'appliance') return applianceDeviceType(spec.appliance)
  if (spec.kind !== 'group') return null
  return groupTemplate(spec.templateId)?.memberDeviceType ?? null
}
