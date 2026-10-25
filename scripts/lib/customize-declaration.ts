/**
 * Judge a cap's `customize` declaration (D936). Empty array = clean.
 * The catalog generator refuses to emit when this is not empty.
 */
import { z } from 'zod'
import type {
  CapabilityCustomizeSpec,
  CapabilityCustomizeTarget,
} from '../../packages/types/src/capabilities/customize-spec.ts'
import type {
  CustomizeCompanion,
  CustomizeSourceReport,
  CustomizeSourceSpec,
  CustomizeTransformSpec,
  CustomizeValueKind,
  CustomizeVocabularyRef,
  EventCustomizeTarget,
  KeyedArrayCustomizeTarget,
  KeyedArrayLiteralSpec,
  ScalarCustomizeTarget,
} from '../../packages/types/src/capabilities/customize-spec.ts'
import { CameraSensorModeSchema } from '../../packages/types/src/pipeline/camera-sensors.ts'
import { CAP_VOCABULARY_BY_NAME } from '../../packages/types/src/device/cap-vocabulary/vocabulary.ts'
import {
  arrayElement,
  isOptionalSchema,
  isValueLeaf,
  objectShape,
  resolveCustomizePath,
  type CustomizePathHit,
  type CustomizePathResult,
  type CustomizeValueLeafKind,
} from './customize-path.ts'
import {
  collectCustomizeOwnedPaths,
  collectEventTimestampPaths,
  deriveAdvancedParameters,
} from '../../packages/types/src/capabilities/advanced-parameters.ts'

export type CustomizeViolationRule =
  | 'no-runtime-state'
  | 'empty-targets'
  | 'duplicate-target'
  | 'unknown-path'
  | 'path-into-collection'
  | 'non-leaf'
  | 'unknown-vocabulary'
  | 'vocabulary-cap'
  | 'widened-device-type'
  | 'incompatible-transform'
  | 'empty-transforms'
  | 'empty-sources'
  | 'bad-transform-range'
  | 'bad-source-report'
  | 'missing-companion'
  | 'bad-companion'
  | 'keyed-without-item-array'
  | 'item-array-mismatch'
  | 'item-field'
  | 'unknown-event'
  | 'from-state-mismatch'
  | 'bad-event-path'
  | 'bad-timeout'
  | 'bad-cooldown'
  | 'bad-debounce'
  | 'empty-edges'
  | 'edge-without-source'
  | 'camera-sensors-authority'
  | 'source-modes'
  | 'bad-source-mode'
  | 'event-claims-scalar'
  | 'advanced-wildcard'
  | 'advanced-unknown-path'
  | 'advanced-excluded'

export interface CustomizeViolation {
  readonly capName: string
  readonly targetId?: string
  readonly rule: CustomizeViolationRule
  readonly message: string
}

export interface CustomizeItemArrayView {
  readonly path: string
  readonly keyField: string
  readonly labelField: string
}

export interface CustomizeCapView {
  readonly capName: string
  readonly runtimeState: z.ZodObject<z.core.$ZodLooseShape> | undefined
  readonly deviceTypes: readonly string[] | undefined
  readonly events:
    | Readonly<
        Record<string, { readonly fromState?: { readonly field: string; readonly on: string } }>
      >
    | undefined
  readonly itemArray: CustomizeItemArrayView | undefined
  readonly customize: CapabilityCustomizeSpec | undefined
  readonly vocabularyHas: (ref: CustomizeVocabularyRef) => boolean
}

const SENSOR_MODES = new Set<string>(CameraSensorModeSchema.options)

export function vocabularyHas(ref: CustomizeVocabularyRef): boolean {
  const entry = CAP_VOCABULARY_BY_NAME[ref.cap]
  if (entry === undefined) return false
  if (ref.stateField !== undefined && !entry.state?.some((row) => row.field === ref.stateField)) {
    return false
  }
  if (
    ref.eventName !== undefined &&
    (entry.events === undefined || !(ref.eventName in entry.events))
  ) {
    return false
  }
  return true
}

export function judgeCustomize(view: CustomizeCapView): readonly CustomizeViolation[] {
  const spec = view.customize
  const runtime = view.runtimeState
  if (spec === undefined) return []
  if (runtime === undefined) {
    return [fail(view, undefined, 'no-runtime-state', 'declares customize but no runtimeState')]
  }
  // A card target is what skips the generic fields card. `advanced: 'derive'`
  // may stand alone so an existing device lists the derived rows and a
  // composed device keeps that generic card.
  if (spec.targets.length === 0) {
    if (spec.advanced !== 'derive') {
      return [fail(view, undefined, 'empty-targets', 'customize declares no targets')]
    }
    return judgeAdvanced(view, spec, runtime)
  }
  return [
    ...duplicateTargetIds(view, spec),
    ...spec.targets.flatMap((target) => judgeTarget(view, target, runtime)),
    ...eventClaimsScalar(view, spec),
    ...judgeAdvanced(view, spec, runtime),
  ]
}

function judgeAdvanced(
  view: CustomizeCapView,
  spec: CapabilityCustomizeSpec,
  runtime: z.ZodObject<z.core.$ZodLooseShape>,
): readonly CustomizeViolation[] {
  const advanced = spec.advanced
  if (advanced === undefined || advanced === 'derive') return []
  const owned = collectCustomizeOwnedPaths(spec)
  const eventTs = collectEventTimestampPaths(spec)
  const allowed = new Set(deriveAdvancedParameters(runtime, owned, eventTs).map((row) => row.path))
  const shape = objectShape(runtime)
  const topKeys = shape === undefined ? new Set<string>() : new Set(Object.keys(shape))
  const violations: CustomizeViolation[] = []
  for (const path of advanced) {
    if (path.includes('*')) {
      violations.push(
        fail(view, undefined, 'advanced-wildcard', `advanced path \`${path}\` contains a wildcard`),
      )
      continue
    }
    if (!topKeys.has(path)) {
      violations.push(
        fail(
          view,
          undefined,
          'advanced-unknown-path',
          `advanced path \`${path}\` is not a top-level runtime key`,
        ),
      )
      continue
    }
    if (!allowed.has(path)) {
      violations.push(
        fail(
          view,
          undefined,
          'advanced-excluded',
          `advanced path \`${path}\` is excluded by the derivation filter`,
        ),
      )
    }
  }
  return violations
}

function judgeTarget(
  view: CustomizeCapView,
  target: CapabilityCustomizeTarget,
  runtime: z.ZodType,
): readonly CustomizeViolation[] {
  switch (target.cardinality) {
    case 'scalar':
      return judgeScalar(view, target, runtime)
    case 'keyedArray':
      return judgeKeyed(view, target, runtime)
    case 'event':
      return judgeEvent(view, target, runtime)
  }
}

function judgeScalar(
  view: CustomizeCapView,
  target: ScalarCustomizeTarget,
  runtime: z.ZodType,
): readonly CustomizeViolation[] {
  const resolved = resolveCustomizePath(runtime, target.path)
  return [
    ...shared(view, target, runtime),
    ...judgeLeafPath(view, target.id, resolved),
    ...judgeValueSources(view, target.id, resolved, target.sources),
    ...judgeCompanions(view, target.id, runtime, target.companions),
    ...judgeAddCoverage(view, target.id, target.apply, runtime, target.path, target.companions),
  ]
}

function judgeKeyed(
  view: CustomizeCapView,
  target: KeyedArrayCustomizeTarget,
  runtime: z.ZodType,
): readonly CustomizeViolation[] {
  return [
    ...shared(view, target, runtime),
    ...judgeItemArray(view, target, runtime),
    ...judgeCompanions(view, target.id, runtime, target.companions),
    ...judgeAddCoverage(view, target.id, target.apply, runtime, target.path, target.companions),
  ]
}

function judgeEvent(
  view: CustomizeCapView,
  target: EventCustomizeTarget,
  runtime: z.ZodType,
): readonly CustomizeViolation[] {
  return [
    ...shared(view, target, runtime),
    ...judgeEventSources(view, target),
    ...judgeAuthority(view, target),
    ...(target.shape === 'pulse' ? judgePulse(view, target, runtime) : judgeSpan(view, target)),
  ]
}

function shared(
  view: CustomizeCapView,
  target: CapabilityCustomizeTarget,
  runtime: z.ZodType,
): readonly CustomizeViolation[] {
  return [
    ...judgeVocabulary(view, target),
    ...judgeDeviceTypes(view, target),
    ...judgeSourceReport(view, target.id, runtime, target.sourceReport),
  ]
}

function judgeLeafPath(
  view: CustomizeCapView,
  targetId: string,
  resolved: CustomizePathResult,
): readonly CustomizeViolation[] {
  if (!resolved.ok) return [fail(view, targetId, resolved.rule, resolved.message)]
  if (!isValueLeaf(resolved.hit.kind)) {
    return [fail(view, targetId, 'non-leaf', `path is a ${resolved.hit.kind}, not a leaf`)]
  }
  return []
}

function judgeValueSources(
  view: CustomizeCapView,
  targetId: string,
  resolved: CustomizePathResult,
  sources: readonly CustomizeSourceSpec[],
): readonly CustomizeViolation[] {
  if (!resolved.ok || !isValueLeaf(resolved.hit.kind)) return []
  if (sources.length === 0) {
    return [
      fail(
        view,
        targetId,
        'empty-sources',
        'a target that accepts no sources cannot be configured',
      ),
    ]
  }
  return sources.flatMap((source) =>
    judgeSourceTransforms(view, targetId, resolved.hit.kind, source),
  )
}

function judgeSourceTransforms(
  view: CustomizeCapView,
  targetId: string,
  targetKind: CustomizeValueLeafKind,
  source: CustomizeSourceSpec,
): readonly CustomizeViolation[] {
  if (source.transforms.length === 0) {
    return [fail(view, targetId, 'empty-transforms', `${source.kind} source lists no transform`)]
  }
  const kinds = sourceValueKinds(source)
  return source.transforms.flatMap((transform) => {
    const range = transformRange(transform)
    if (range !== undefined) return [fail(view, targetId, 'bad-transform-range', range)]
    if (transformFits(transform, targetKind, kinds)) return []
    return [
      fail(
        view,
        targetId,
        'incompatible-transform',
        `${transform.kind} cannot write a ${targetKind} from ${kinds.join('|')}`,
      ),
    ]
  })
}

function judgeVocabulary(
  view: CustomizeCapView,
  target: CapabilityCustomizeTarget,
): readonly CustomizeViolation[] {
  if (target.vocabulary.cap !== view.capName) {
    return [
      fail(
        view,
        target.id,
        'vocabulary-cap',
        `vocabulary cap \`${target.vocabulary.cap}\` is not \`${view.capName}\``,
      ),
    ]
  }
  if (!view.vocabularyHas(target.vocabulary)) {
    return [
      fail(view, target.id, 'unknown-vocabulary', 'vocabulary reference is not in the D920 map'),
    ]
  }
  return []
}

function judgeDeviceTypes(
  view: CustomizeCapView,
  target: CapabilityCustomizeTarget,
): readonly CustomizeViolation[] {
  if (target.deviceTypes === undefined || view.deviceTypes === undefined) return []
  const extra = target.deviceTypes.filter((type) => !view.deviceTypes?.includes(type))
  if (extra.length === 0) return []
  return [
    fail(
      view,
      target.id,
      'widened-device-type',
      `device types not on the cap: ${extra.join(', ')}`,
    ),
  ]
}

function judgeSourceReport(
  view: CustomizeCapView,
  targetId: string,
  runtime: z.ZodType,
  report: CustomizeSourceReport,
): readonly CustomizeViolation[] {
  if (report.runtimeField === undefined) {
    if (report.nativeValue !== undefined || report.assignedValue !== undefined) {
      return [
        fail(view, targetId, 'bad-source-report', 'native/assigned values require runtimeField'),
      ]
    }
    return []
  }
  if (report.nativeValue === undefined || report.assignedValue === undefined) {
    return [
      fail(view, targetId, 'bad-source-report', 'runtimeField needs nativeValue and assignedValue'),
    ]
  }
  const resolved = resolveCustomizePath(runtime, report.runtimeField)
  if (!resolved.ok) return [fail(view, targetId, 'bad-source-report', resolved.message)]
  if (resolved.hit.kind !== 'enum' && resolved.hit.kind !== 'string') {
    return [
      fail(view, targetId, 'bad-source-report', `${report.runtimeField} is not a string or enum`),
    ]
  }
  if (
    resolved.hit.kind === 'enum' &&
    !enumHolds(resolved.hit, report.nativeValue, report.assignedValue)
  ) {
    return [
      fail(view, targetId, 'bad-source-report', 'native/assigned values are not enum options'),
    ]
  }
  return []
}

function judgeCompanions(
  view: CustomizeCapView,
  targetId: string,
  runtime: z.ZodType,
  companions: readonly CustomizeCompanion[] | undefined,
): readonly CustomizeViolation[] {
  return (companions ?? []).flatMap((companion) => {
    const resolved = resolveCustomizePath(runtime, companion.path)
    if (!resolved.ok) return [fail(view, targetId, 'bad-companion', resolved.message)]
    if (companion.kind === 'constant') {
      return valueFits(resolved.hit, companion.value)
        ? []
        : [
            fail(
              view,
              targetId,
              'bad-companion',
              `${companion.path} cannot hold ${String(companion.value)}`,
            ),
          ]
    }
    if (resolved.hit.kind !== 'number') {
      return [fail(view, targetId, 'bad-companion', `${companion.path} is not a timestamp`)]
    }
    return []
  })
}

function judgeAddCoverage(
  view: CustomizeCapView,
  targetId: string,
  apply: ScalarCustomizeTarget['apply'],
  runtime: z.ZodType,
  targetPath: string,
  companions: readonly CustomizeCompanion[] | undefined,
): readonly CustomizeViolation[] {
  if (apply === 'replace') return []
  const shape = objectShape(runtime)
  if (shape === undefined) return []
  const covered = new Set<string>([
    rootKey(targetPath),
    ...(companions ?? []).map((companion) => rootKey(companion.path)),
  ])
  const missing = Object.entries(shape)
    .filter(([key, schema]) => !isOptionalSchema(schema) && !covered.has(key))
    .map(([key]) => key)
  if (missing.length === 0) return []
  return [fail(view, targetId, 'missing-companion', `add mode leaves ${missing.join(', ')} unset`)]
}

function judgeItemArray(
  view: CustomizeCapView,
  target: KeyedArrayCustomizeTarget,
  runtime: z.ZodType,
): readonly CustomizeViolation[] {
  const declared = view.itemArray
  if (declared === undefined) {
    return [
      fail(view, target.id, 'keyed-without-item-array', 'keyedArray requires status.itemArray'),
    ]
  }
  if (
    declared.path !== target.path ||
    declared.keyField !== target.keyField ||
    declared.labelField !== target.labelField
  ) {
    return [
      fail(
        view,
        target.id,
        'item-array-mismatch',
        'keyedArray does not agree with status.itemArray',
      ),
    ]
  }
  const resolved = resolveCustomizePath(runtime, target.path)
  if (!resolved.ok) return [fail(view, target.id, resolved.rule, resolved.message)]
  if (resolved.hit.kind !== 'array') {
    return [fail(view, target.id, 'non-leaf', `${target.path} is not an array`)]
  }
  const element = arrayElement(resolved.hit.schema)
  if (element === undefined) {
    return [fail(view, target.id, 'item-field', `${target.path} has no item schema`)]
  }
  return [
    ...judgeItemKey(view, target, target.itemSchema, element, target.keyField),
    ...judgeItemKey(view, target, target.itemSchema, element, target.labelField),
    ...judgeTraits(view, target),
    ...target.fields.flatMap((field) =>
      judgeItemField(view, target, element, field.path, field.sources, field.literals),
    ),
  ]
}

function judgeItemKey(
  view: CustomizeCapView,
  target: KeyedArrayCustomizeTarget,
  itemSchema: z.ZodType,
  element: z.ZodType,
  field: string,
): readonly CustomizeViolation[] {
  const onDeclaration = resolveCustomizePath(itemSchema, field)
  const onRuntime = resolveCustomizePath(element, field)
  if (!onDeclaration.ok || !onRuntime.ok) {
    return [fail(view, target.id, 'item-field', `\`${field}\` is absent from the item schema`)]
  }
  return []
}

function judgeTraits(
  view: CustomizeCapView,
  target: KeyedArrayCustomizeTarget,
): readonly CustomizeViolation[] {
  return (target.traits ?? []).flatMap((trait) => {
    const resolved = resolveCustomizePath(target.itemSchema, trait.path)
    if (!resolved.ok || resolved.hit.kind !== 'enum') {
      return [fail(view, target.id, 'item-trait', `\`${trait.path}\` is not an item enum`)]
    }
    const outside = trait.values.filter((value) => !resolved.hit.enumValues.includes(value))
    if (outside.length > 0 || !trait.values.includes(trait.defaultValue)) {
      return [fail(view, target.id, 'item-trait', `\`${trait.path}\` values are not the item enum`)]
    }
    return []
  })
}

function judgeItemField(
  view: CustomizeCapView,
  target: KeyedArrayCustomizeTarget,
  element: z.ZodType,
  fieldPath: string,
  sources: readonly CustomizeSourceSpec[],
  literals: readonly KeyedArrayLiteralSpec[] | undefined,
): readonly CustomizeViolation[] {
  const onDeclaration = resolveCustomizePath(target.itemSchema, fieldPath)
  const onRuntime = resolveCustomizePath(element, fieldPath)
  if (!onDeclaration.ok || !onRuntime.ok) {
    return [fail(view, target.id, 'item-field', `\`${fieldPath}\` is absent from the item schema`)]
  }
  if (!isValueLeaf(onDeclaration.hit.kind) || onDeclaration.hit.kind !== onRuntime.hit.kind) {
    return [
      fail(view, target.id, 'item-field', `\`${fieldPath}\` is not a leaf the runtime item shares`),
    ]
  }
  return [
    ...judgeValueSources(view, target.id, onDeclaration, sources),
    ...judgeFieldLiterals(view, target, literals),
  ]
}

function judgeFieldLiterals(
  view: CustomizeCapView,
  target: KeyedArrayCustomizeTarget,
  literals: readonly KeyedArrayLiteralSpec[] | undefined,
): readonly CustomizeViolation[] {
  return (literals ?? []).flatMap((literal) => {
    const resolved = resolveCustomizePath(target.itemSchema, literal.path)
    if (!resolved.ok || (resolved.hit.kind !== 'enum' && resolved.hit.kind !== 'string')) {
      return [fail(view, target.id, 'item-literal', `\`${literal.path}\` is not an item enum`)]
    }
    if (literal.values.length === 0) {
      return [fail(view, target.id, 'item-literal', `\`${literal.path}\` lists no values`)]
    }
    if (resolved.hit.kind === 'string') return []
    const outside = literal.values.filter((value) => !resolved.hit.enumValues.includes(value))
    if (outside.length === 0) return []
    return [
      fail(view, target.id, 'item-literal', `\`${literal.path}\` values are not the item enum`),
    ]
  })
}

function judgeEventSources(
  view: CustomizeCapView,
  target: EventCustomizeTarget,
): readonly CustomizeViolation[] {
  if (target.sources.length === 0) {
    return [fail(view, target.id, 'empty-sources', 'an event target lists no source kind')]
  }
  return []
}

function judgeAuthority(
  view: CustomizeCapView,
  target: EventCustomizeTarget,
): readonly CustomizeViolation[] {
  if (target.applyAuthority.kind === 'camera-sensors') {
    if (target.shape !== 'span' || target.eventName !== 'onMotionChanged') {
      return [
        fail(
          view,
          target.id,
          'camera-sensors-authority',
          'camera-sensors applies only to a span whose event is onMotionChanged',
        ),
      ]
    }
  }
  if (target.shape !== 'span' || target.sourceModes === undefined) return []
  if (target.applyAuthority.kind !== 'camera-sensors') {
    return [
      fail(view, target.id, 'source-modes', 'sourceModes belong to the camera-sensors authority'),
    ]
  }
  const bad = target.sourceModes.filter((mode) => !SENSOR_MODES.has(mode))
  if (bad.length === 0) return []
  return [
    fail(
      view,
      target.id,
      'bad-source-mode',
      `source mode is not a camera sensor mode: ${bad.join(', ')}`,
    ),
  ]
}

function judgePulse(
  view: CustomizeCapView,
  target: EventCustomizeTarget & { readonly shape: 'pulse' },
  runtime: z.ZodType,
): readonly CustomizeViolation[] {
  return [
    ...judgeNamedEvent(view, target.id, target.eventName, target.timestampPath),
    ...judgeNumberPath(view, target.id, runtime, target.timestampPath, 'timestamp'),
    ...judgeNumberPath(view, target.id, runtime, target.counterPath, 'counter'),
    ...judgeDebounce(view, target),
    ...judgeEdges(view, target),
  ]
}

function judgeSpan(
  view: CustomizeCapView,
  target: EventCustomizeTarget & { readonly shape: 'span' },
): readonly CustomizeViolation[] {
  const timeout =
    Number.isFinite(target.timeoutMs) && target.timeoutMs >= 0
      ? []
      : [fail(view, target.id, 'bad-timeout', 'span timeoutMs is missing or negative')]
  const cooldown =
    target.cooldownMs === undefined ||
    (Number.isFinite(target.cooldownMs) && target.cooldownMs >= 0)
      ? []
      : [fail(view, target.id, 'bad-cooldown', 'span cooldownMs is negative')]
  return [...judgeNamedEvent(view, target.id, target.eventName, undefined), ...timeout, ...cooldown]
}

function judgeNamedEvent(
  view: CustomizeCapView,
  targetId: string,
  eventName: string,
  timestampPath: string | undefined,
): readonly CustomizeViolation[] {
  const event = view.events?.[eventName]
  if (event === undefined) {
    return [
      fail(view, targetId, 'unknown-event', `event \`${eventName}\` is not declared by the cap`),
    ]
  }
  if (timestampPath === undefined || event.fromState === undefined) return []
  if (event.fromState.field === timestampPath && event.fromState.on === 'advance') return []
  return [
    fail(
      view,
      targetId,
      'from-state-mismatch',
      `fromState advances \`${event.fromState.field}\`, not \`${timestampPath}\``,
    ),
  ]
}

function judgeNumberPath(
  view: CustomizeCapView,
  targetId: string,
  runtime: z.ZodType,
  dotted: string,
  role: string,
): readonly CustomizeViolation[] {
  const resolved = resolveCustomizePath(runtime, dotted)
  if (!resolved.ok) return [fail(view, targetId, 'bad-event-path', resolved.message)]
  if (resolved.hit.kind !== 'number') {
    return [fail(view, targetId, 'bad-event-path', `${role} path \`${dotted}\` is not a number`)]
  }
  return []
}

function judgeDebounce(
  view: CustomizeCapView,
  target: EventCustomizeTarget & { readonly shape: 'pulse' },
): readonly CustomizeViolation[] {
  if (Number.isFinite(target.debounce.defaultDebounceMs) && target.debounce.defaultDebounceMs >= 0)
    return []
  return [fail(view, target.id, 'bad-debounce', 'pulse debounce is negative')]
}

function judgeEdges(
  view: CustomizeCapView,
  target: EventCustomizeTarget & { readonly shape: 'pulse' },
): readonly CustomizeViolation[] {
  if (target.edges.length === 0)
    return [fail(view, target.id, 'empty-edges', 'a pulse names no edge')]
  const needsLevel = target.edges.includes('rising') || target.edges.includes('button')
  const hasLevel = target.sources.some(
    (source) => source.kind === 'binary' || source.kind === 'switch',
  )
  if (needsLevel && !hasLevel) {
    return [
      fail(view, target.id, 'edge-without-source', 'a level edge needs a binary or switch source'),
    ]
  }
  if (
    target.edges.includes('native-event') &&
    !target.sources.some((source) => source.kind === 'native-event')
  ) {
    return [
      fail(
        view,
        target.id,
        'edge-without-source',
        'a native-event edge needs a native-event source',
      ),
    ]
  }
  return []
}

function eventClaimsScalar(
  view: CustomizeCapView,
  spec: CapabilityCustomizeSpec,
): readonly CustomizeViolation[] {
  const events = spec.targets.filter((target) => target.cardinality === 'event')
  const scalars = spec.targets.filter((target) => target.cardinality === 'scalar')
  return events.flatMap((event) =>
    scalars.flatMap((scalar) => {
      const sameEvent =
        scalar.vocabulary.eventName !== undefined && scalar.vocabulary.eventName === event.eventName
      const samePulse = event.shape === 'pulse' && scalar.path === event.timestampPath
      if (!sameEvent && !samePulse) return []
      return [
        fail(
          view,
          event.id,
          'event-claims-scalar',
          `scalar \`${scalar.id}\` claims the same event state`,
        ),
      ]
    }),
  )
}

function duplicateTargetIds(
  view: CustomizeCapView,
  spec: CapabilityCustomizeSpec,
): readonly CustomizeViolation[] {
  const seen = new Set<string>()
  return spec.targets.flatMap((target) => {
    if (seen.has(target.id)) {
      return [
        fail(view, target.id, 'duplicate-target', `target id \`${target.id}\` is declared twice`),
      ]
    }
    seen.add(target.id)
    return []
  })
}

function sourceValueKinds(source: CustomizeSourceSpec): readonly CustomizeValueKind[] {
  switch (source.kind) {
    case 'switch':
    case 'binary':
      return ['boolean']
    case 'numeric':
      return ['number']
    case 'enum':
      return ['string', 'enum']
    case 'field':
      return source.valueKinds
  }
}

function transformFits(
  transform: CustomizeTransformSpec,
  targetKind: CustomizeValueLeafKind,
  valueKinds: readonly CustomizeValueKind[],
): boolean {
  if (valueKinds.length === 0) return false
  switch (transform.kind) {
    case 'identity':
      return valueKinds.every((kind) => kindFits(targetKind, kind, true))
    case 'linear':
      return targetKind === 'number' && valueKinds.every((kind) => kindFits('number', kind, true))
    case 'invert':
      return targetKind === 'boolean' && valueKinds.every((kind) => kind === 'boolean')
    case 'threshold':
      return targetKind === 'boolean' && valueKinds.every((kind) => kind === 'number')
    case 'enum-map':
      return (
        (targetKind === 'enum' || targetKind === 'string') &&
        valueKinds.every((kind) => kind === 'string' || kind === 'enum')
      )
  }
}

function kindFits(
  target: CustomizeValueLeafKind,
  source: CustomizeValueKind,
  bridgeStringToNumber: boolean,
): boolean {
  if (source === target) return true
  if (target === 'enum' && source === 'string') return true
  if (target === 'string' && source === 'enum') return true
  if (bridgeStringToNumber && target === 'number' && source === 'string') return true
  return false
}

function transformRange(transform: CustomizeTransformSpec): string | undefined {
  if (transform.kind === 'linear') {
    if (
      transform.clampMin !== undefined &&
      transform.clampMax !== undefined &&
      transform.clampMin > transform.clampMax
    ) {
      return 'linear clampMin is above clampMax'
    }
    return undefined
  }
  if (transform.kind === 'threshold') {
    if (transform.defaultStartDwellMs < 0 || transform.defaultStopDwellMs < 0)
      return 'threshold dwell is negative'
  }
  return undefined
}

function enumHolds(hit: CustomizePathHit, nativeValue: string, assignedValue: string): boolean {
  return hit.enumValues.includes(nativeValue) && hit.enumValues.includes(assignedValue)
}

function valueFits(hit: CustomizePathHit, value: string | number | boolean | null): boolean {
  if (value === null) return hit.nullable
  switch (hit.kind) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number'
    case 'string':
      return typeof value === 'string'
    case 'enum':
      return typeof value === 'string' && hit.enumValues.includes(value)
    default:
      return false
  }
}

function rootKey(dotted: string): string {
  return dotted.split('.')[0] ?? dotted
}

function fail(
  view: CustomizeCapView,
  targetId: string | undefined,
  rule: CustomizeViolationRule,
  message: string,
): CustomizeViolation {
  return {
    capName: view.capName,
    ...(targetId === undefined ? {} : { targetId }),
    rule,
    message,
  }
}

export { loadCustomizeCaps } from './customize-load.ts'
