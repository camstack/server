/**
 * Per-kind JSON Schemas for a constrained-decoding backend — hand-written and
 * SIMPLIFIED, not `z.toJSONSchema` of the recipe (that is thousands of lines of
 * recursion a small model cannot follow). What the schema does:
 *
 *  - the `when` tree is unrolled to {@link WHEN_UNROLL_DEPTH} levels;
 *  - every id the model could invent is an `enum` taken from the vocabulary
 *    slice: device ids, caps, field paths, vocabulary action ids, zones, rooms;
 *  - only the leaves and steps a description normally needs are offered
 *    (no expression leaf, no code step) — a longer tail goes through the editor.
 *
 * The schema is a first filter, never the verdict: `validateDraft` still parses
 * with the real Zod schemas and the kind's own validator.
 */
import { compositionTargetCaps } from './composition-caps.js'
import type { DraftKind, JsonSchema, VocabularySlice } from './draft-types.js'

export const WHEN_UNROLL_DEPTH = 3

const CAMERA_TYPE = 'camera'
const OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'] as const
const DETECTION_MACROS = ['person', 'animal', 'vehicle', 'package'] as const
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const SUN_EVENTS = ['sunrise', 'sunset', 'dawn', 'dusk'] as const
const SCALAR: JsonSchema = { type: ['string', 'number', 'boolean'] }
const COMPOSITION_DEVICE_TYPES = ['sensor', 'light', 'switch', 'cover', 'climate'] as const

function str(): JsonSchema {
  return { type: 'string' }
}
function int(min?: number, max?: number): JsonSchema {
  return {
    type: 'integer',
    ...(min === undefined ? {} : { minimum: min }),
    ...(max === undefined ? {} : { maximum: max }),
  }
}
function lit(value: string): JsonSchema {
  return { const: value }
}
function enumOf(values: readonly (string | number)[]): JsonSchema {
  return values.length === 0 ? str() : { enum: [...values] }
}
function arr(items: JsonSchema, minItems = 1): JsonSchema {
  return { type: 'array', items, minItems }
}
function obj(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
): JsonSchema {
  return { type: 'object', properties, required: [...required], additionalProperties: false }
}
function anyOf(options: readonly JsonSchema[]): JsonSchema {
  return { anyOf: [...options] }
}

interface Ids {
  readonly deviceIds: readonly number[]
  readonly cameraIds: readonly number[]
  readonly caps: readonly string[]
  readonly fieldPaths: readonly string[]
  readonly actionIds: readonly string[]
  readonly zones: readonly string[]
  readonly rooms: readonly string[]
  readonly categories: readonly string[]
  readonly deviceTypes: readonly string[]
}

function idsOf(slice: VocabularySlice): Ids {
  return {
    deviceIds: slice.devices.map((d) => d.id),
    cameraIds: slice.devices.filter((d) => d.type === CAMERA_TYPE).map((d) => d.id),
    caps: slice.caps.map((c) => c.cap),
    fieldPaths: [...new Set(slice.caps.flatMap((c) => c.fields.map((f) => f.path)))].toSorted(),
    actionIds: slice.caps.flatMap((c) => c.actions.map((a) => a.id)),
    zones: slice.zones,
    rooms: slice.rooms,
    categories: slice.eventCategories,
    deviceTypes: slice.deviceTypes,
  }
}

function timeSpec(allowDate: boolean): JsonSchema {
  const clock = obj({ kind: lit('clock'), hh: int(0, 23), mm: int(0, 59) }, ['kind', 'hh', 'mm'])
  const sun = obj({ kind: lit('sun'), event: enumOf(SUN_EVENTS), offsetMin: int(-720, 720) }, [
    'kind',
    'event',
    'offsetMin',
  ])
  const date = obj({ kind: lit('date'), local: str() }, ['kind', 'local'])
  return anyOf(allowDate ? [clock, sun, date] : [clock, sun])
}

function eventLeaves(ids: Ids): readonly JsonSchema[] {
  const becomes = obj(
    {
      kind: lit('device-becomes'),
      deviceId: enumOf(ids.deviceIds),
      cap: enumOf(ids.caps),
      fieldPath: enumOf(ids.fieldPaths),
      becomes: SCALAR,
      forMs: int(0, 86_400_000),
    },
    ['kind', 'deviceId', 'cap', 'fieldPath', 'becomes'],
  )
  const event = obj(
    {
      kind: lit('device-event'),
      category: enumOf(ids.categories),
      deviceId: enumOf(ids.deviceIds),
    },
    ['kind', 'category'],
  )
  const schedule = obj({ kind: lit('schedule'), at: timeSpec(true), days: arr(enumOf(WEEKDAYS)) }, [
    'kind',
    'at',
  ])
  const interval = obj({ kind: lit('interval'), minutes: int(1, 1440) }, ['kind', 'minutes'])
  const manual = obj({ kind: lit('manual') }, ['kind'])
  const detection = obj(
    {
      kind: lit('detection'),
      subjects: arr(obj({ macro: enumOf(DETECTION_MACROS) }, ['macro'])),
      deviceIds: arr(enumOf(ids.cameraIds)),
      zones: arr(enumOf(ids.zones)),
      minScore: { type: 'number', minimum: 0, maximum: 1 },
    },
    ['kind', 'subjects', 'deviceIds'],
  )
  return [
    becomes,
    ...(ids.categories.length > 0 ? [event] : []),
    schedule,
    interval,
    manual,
    ...(ids.cameraIds.length > 0 ? [detection] : []),
  ]
}

function stateLeaves(ids: Ids): readonly JsonSchema[] {
  const valueSchema: JsonSchema = { type: ['string', 'number', 'boolean'] }
  return [
    obj(
      {
        kind: lit('device-is'),
        deviceId: enumOf(ids.deviceIds),
        cap: enumOf(ids.caps),
        fieldPath: enumOf(ids.fieldPaths),
        operator: enumOf(OPERATORS),
        value: valueSchema,
      },
      ['kind', 'deviceId', 'cap', 'fieldPath', 'operator', 'value'],
    ),
  ]
}

function whenTree(leaves: readonly JsonSchema[], depth: number): JsonSchema {
  if (depth <= 1) return anyOf(leaves)
  const inner = whenTree(leaves, depth - 1)
  return anyOf([
    ...leaves,
    obj({ kind: lit('all'), children: arr(inner) }, ['kind', 'children']),
    obj({ kind: lit('any'), children: arr(inner) }, ['kind', 'children']),
    obj({ kind: lit('not'), child: inner }, ['kind', 'child']),
  ])
}

function steps(ids: Ids, slice: VocabularySlice, max: number): JsonSchema {
  const target = anyOf([
    obj({ kind: lit('devices'), ids: arr(enumOf(ids.deviceIds)) }, ['kind', 'ids']),
    obj({ kind: lit('domain'), deviceType: enumOf(ids.deviceTypes), roomId: enumOf(ids.rooms) }, [
      'kind',
    ]),
  ])
  const capStep = obj(
    {
      kind: lit('cap'),
      actionId: enumOf(ids.actionIds),
      target,
      args: { type: 'object' },
    },
    ['kind', 'actionId', 'target'],
  )
  const wait = obj({ kind: lit('wait'), seconds: { type: 'number', minimum: 0, maximum: 300 } }, [
    'kind',
    'seconds',
  ])
  const called = obj(
    {
      kind: lit('action'),
      actionId: enumOf(slice.internalActions.map((a) => a.id)),
      variables: { type: 'object' },
    },
    ['kind', 'actionId'],
  )
  return {
    type: 'array',
    minItems: 1,
    maxItems: max,
    items: anyOf([capStep, wait, ...(slice.internalActions.length > 0 ? [called] : [])]),
  }
}

function automationSchema(ids: Ids, slice: VocabularySlice): JsonSchema {
  return obj(
    {
      when: whenTree([...eventLeaves(ids), ...stateLeaves(ids)], WHEN_UNROLL_DEPTH),
      actions: steps(ids, slice, 12),
      runMode: anyOf([
        obj({ mode: lit('single') }, ['mode']),
        obj({ mode: lit('restart') }, ['mode']),
        obj({ mode: lit('cooldown'), minutes: int(1, 1440) }, ['mode', 'minutes']),
      ]),
    },
    ['when', 'actions'],
  )
}

function actionSchema(ids: Ids, slice: VocabularySlice): JsonSchema {
  const capOnly = steps(ids, { ...slice, internalActions: [] }, 20)
  return obj({ name: { type: 'string', minLength: 1, maxLength: 120 }, steps: capOnly }, [
    'name',
    'steps',
  ])
}

function schedulerSchema(ids: Ids, slice: VocabularySlice): JsonSchema {
  const conditions = whenTree(stateLeaves(ids), WHEN_UNROLL_DEPTH)
  const point = obj(
    {
      id: str(),
      at: timeSpec(false),
      mode: enumOf(['edge', 'hold', 'release']),
      steps: { ...steps(ids, { ...slice, internalActions: [] }, 20), minItems: 0 },
      conditions,
    },
    ['id', 'at', 'mode'],
  )
  const profile = obj(
    {
      id: str(),
      name: str(),
      days: arr(enumOf(WEEKDAYS)),
      points: arr(point),
      activeWhen: conditions,
    },
    ['id', 'name', 'days', 'points'],
  )
  return obj(
    { name: str(), priority: int(0, 100), activeWhen: conditions, profiles: arr(profile) },
    ['name', 'profiles'],
  )
}

function compositionSchema(slice: VocabularySlice): JsonSchema {
  const sources = slice.devices.map((d) => d.addonId)
  const stable = slice.devices.map((d) => d.stableId)
  const ref = obj({ addonId: enumOf([...new Set(sources)]), stableId: enumOf(stable) }, [
    'addonId',
    'stableId',
  ])
  const read = obj({ source: ref, cap: enumOf(slice.caps.map((c) => c.cap)), fieldPath: str() }, [
    'source',
    'cap',
    'fieldPath',
  ])
  const from = obj({ kind: lit('from'), source: ref, cap: str(), fieldPath: str() }, [
    'kind',
    'source',
    'cap',
    'fieldPath',
  ])
  const literal = obj(
    { kind: lit('literal'), value: { type: ['string', 'number', 'boolean', 'null'] } },
    ['kind', 'value'],
  )
  const expression = obj(
    {
      kind: lit('expression'),
      expr: str(),
      bindings: { type: 'object', additionalProperties: anyOf([from, literal]) },
    },
    ['kind', 'expr', 'bindings'],
  )
  const aggregate = obj(
    {
      kind: lit('aggregate'),
      reducer: enumOf(['mean', 'median', 'min', 'max', 'sum', 'any', 'all']),
      reads: arr(read),
      publish: enumOf(['value', 'included', 'excluded', 'total']),
      empty: enumOf(['null', 'omit', 'offline']),
    },
    ['kind', 'reducer', 'reads', 'publish', 'empty'],
  )
  const feature = obj(
    {
      kind: lit('fields'),
      cap: enumOf(compositionTargetCaps().map((c) => c.cap)),
      fields: { type: 'object', additionalProperties: anyOf([from, expression, aggregate]) },
    },
    ['kind', 'cap', 'fields'],
  )
  const target = obj({ kind: lit('new'), type: enumOf(COMPOSITION_DEVICE_TYPES), role: str() }, [
    'kind',
    'type',
  ])
  return obj({ target, features: arr(feature) }, ['target', 'features'])
}

/** The JSON Schema a constrained backend decodes `kind` against, for this slice. */
export function buildDraftJsonSchema(kind: DraftKind, slice: VocabularySlice): JsonSchema {
  const ids = idsOf(slice)
  const body: JsonSchema = (() => {
    switch (kind) {
      case 'automation':
        return automationSchema(ids, slice)
      case 'action':
        return actionSchema(ids, slice)
      case 'scheduler':
        return schedulerSchema(ids, slice)
      case 'composition':
        return compositionSchema(slice)
    }
  })()
  return { $schema: 'http://json-schema.org/draft-07/schema#', title: `${kind}-draft`, ...body }
}
