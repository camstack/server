/**
 * What a `cover` device is to Alexa (D869) — pure, so the discovery shape, the
 * slice mapping and the directive handlers share one definition.
 *
 *   positionable → `Alexa.RangeController` `Blind.Position` 0–100 %, the
 *                  localized `Alexa.Setting.Opening` asset, voice semantics
 *                  (Open = 100, Close = 0, Raise / Lower = ±10 via
 *                  AdjustRangeValue; states Closed = 0, Open = 1–100)
 *   not          → `Alexa.ModeController` `Blind.State` Open / Closed with the
 *                  same semantics
 *   has tilt     → a second `Alexa.RangeController`, `Blind.Tilt`, no semantics
 *
 * CamStack's `cover` position is 0 = closed, 100 = open: the same direction as
 * Alexa's Opening, so nothing is inverted.
 */
import { CoverStatusSchema } from '@camstack/types'
import type {
  AlexaActionMapping,
  AlexaCapability,
  AlexaDisplayCategory,
  AlexaStateMapping,
} from '../types.js'
import type { AdapterDevice, GenericProperty } from './types.js'

export const INSTANCE_POSITION = 'Blind.Position'
export const INSTANCE_TILT = 'Blind.Tilt'
export const INSTANCE_STATE = 'Blind.State'
export const MODE_OPEN = 'State.Open'
export const MODE_CLOSED = 'State.Closed'
/** What Raise / Lower move the position by (percentage points). */
export const ADJUST_STEP = 10
/** A reading this close to the target counts as arrived. */
export const ARRIVAL_TOLERANCE = 2

const FEATURE_POSITIONABLE = 'cover-positionable'
const FEATURE_TILT = 'cover-tilt'

/** The KIND of a cover, from its device role. */
export type CoverKind =
  | 'blind'
  | 'shutter'
  | 'awning'
  | 'curtain'
  | 'garage'
  | 'gate'
  | 'door'
  | 'window'

const KIND_BY_ROLE: Readonly<Record<string, CoverKind>> = {
  'cover-blind': 'blind',
  'cover-shutter': 'shutter',
  'cover-awning': 'awning',
  'cover-curtain': 'curtain',
  'cover-garage': 'garage',
  'cover-gate': 'gate',
  'cover-door': 'door',
  'cover-window': 'window',
}

/** A cover without a kind (a `damper`, an unclassified entity) is a blind. */
export function coverKindOf(role: string | null): CoverKind {
  return (role === null ? undefined : KIND_BY_ROLE[role]) ?? 'blind'
}

/** Kinds that open onto the outside or a way in: P5, not exposed yet. */
const SECURITY_KINDS: ReadonlySet<CoverKind> = new Set(['garage', 'gate', 'door'])

export function isSecurityKind(kind: CoverKind): boolean {
  return SECURITY_KINDS.has(kind)
}

export function coverCategoryFor(kind: CoverKind): AlexaDisplayCategory {
  switch (kind) {
    case 'blind':
    case 'curtain':
      return 'INTERIOR_BLIND'
    case 'shutter':
    case 'awning':
      return 'EXTERIOR_BLIND'
    default:
      return 'OTHER'
  }
}

const OPENING_ASSET = {
  friendlyNames: [{ '@type': 'asset', value: { assetId: 'Alexa.Setting.Opening' } }],
} as const

const TILT_NAMES = {
  friendlyNames: [
    { '@type': 'text', value: { text: 'Inclinazione', locale: 'it-IT' } },
    { '@type': 'text', value: { text: 'Tilt', locale: 'en-US' } },
  ],
} as const

const OPEN_CLOSE_SEMANTIC_STATES = { closed: 'Alexa.States.Closed', open: 'Alexa.States.Open' }

function rangeActions(): readonly AlexaActionMapping[] {
  const set = (actions: string[], rangeValue: number): AlexaActionMapping => ({
    '@type': 'ActionsToDirective',
    actions,
    directive: { name: 'SetRangeValue', payload: { rangeValue } },
  })
  const adjust = (actions: string[], rangeValueDelta: number): AlexaActionMapping => ({
    '@type': 'ActionsToDirective',
    actions,
    directive: {
      name: 'AdjustRangeValue',
      payload: { rangeValueDelta, rangeValueDeltaDefault: false },
    },
  })
  return [
    set(['Alexa.Actions.Close'], 0),
    set(['Alexa.Actions.Open'], 100),
    adjust(['Alexa.Actions.Lower'], -ADJUST_STEP),
    adjust(['Alexa.Actions.Raise'], ADJUST_STEP),
  ]
}

function rangeStates(): readonly AlexaStateMapping[] {
  return [
    { '@type': 'StatesToValue', states: [OPEN_CLOSE_SEMANTIC_STATES.closed], value: 0 },
    {
      '@type': 'StatesToRange',
      states: [OPEN_CLOSE_SEMANTIC_STATES.open],
      range: { minimumValue: 1, maximumValue: 100 },
    },
  ]
}

function rangeProperties(): NonNullable<AlexaCapability['properties']> {
  return { supported: [{ name: 'rangeValue' }], proactivelyReported: true, retrievable: true }
}

const PERCENT_RANGE = {
  supportedRange: { minimumValue: 0, maximumValue: 100, precision: 1 },
  unitOfMeasure: 'Alexa.Unit.Percent',
}

function positionCapability(): AlexaCapability {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.RangeController',
    version: '3',
    instance: INSTANCE_POSITION,
    capabilityResources: OPENING_ASSET,
    properties: rangeProperties(),
    configuration: PERCENT_RANGE,
    semantics: { actionMappings: rangeActions(), stateMappings: rangeStates() },
  }
}

function tiltCapability(): AlexaCapability {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.RangeController',
    version: '3',
    instance: INSTANCE_TILT,
    capabilityResources: TILT_NAMES,
    properties: rangeProperties(),
    configuration: PERCENT_RANGE,
  }
}

function stateCapability(): AlexaCapability {
  const modeNames = (assetId: string) => ({
    friendlyNames: [{ '@type': 'asset', value: { assetId } }],
  })
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ModeController',
    version: '3',
    instance: INSTANCE_STATE,
    capabilityResources: OPENING_ASSET,
    properties: { supported: [{ name: 'mode' }], proactivelyReported: true, retrievable: true },
    configuration: {
      ordered: false,
      supportedModes: [
        { value: MODE_OPEN, modeResources: modeNames('Alexa.Value.Open') },
        { value: MODE_CLOSED, modeResources: modeNames('Alexa.Value.Close') },
      ],
    },
    semantics: {
      actionMappings: [
        {
          '@type': 'ActionsToDirective',
          actions: ['Alexa.Actions.Close'],
          directive: { name: 'SetMode', payload: { mode: MODE_CLOSED } },
        },
        {
          '@type': 'ActionsToDirective',
          actions: ['Alexa.Actions.Open'],
          directive: { name: 'SetMode', payload: { mode: MODE_OPEN } },
        },
      ],
      stateMappings: [
        {
          '@type': 'StatesToValue',
          states: [OPEN_CLOSE_SEMANTIC_STATES.closed],
          value: MODE_CLOSED,
        },
        { '@type': 'StatesToValue', states: [OPEN_CLOSE_SEMANTIC_STATES.open], value: MODE_OPEN },
      ],
    },
  }
}

const SliceShape = CoverStatusSchema.pick({ state: true, position: true, tiltPosition: true })

function hasNumber(slice: unknown, key: 'position' | 'tiltPosition'): boolean {
  const parsed = SliceShape.safeParse(slice)
  return parsed.success && parsed.data[key] !== null
}

/** The capabilities of a cover device, or why it is not exposed. */
export function describeCover(device: AdapterDevice):
  | {
      readonly kind: 'publish'
      readonly capabilities: readonly AlexaCapability[]
      readonly category: AlexaDisplayCategory
    }
  | { readonly kind: 'skip'; readonly reason: string } {
  const kind = coverKindOf(device.role)
  if (isSecurityKind(kind)) {
    return {
      kind: 'skip',
      reason: `cover kind "${kind}" is a way in — not exposed to Alexa yet (planned: confirmation-gated, P5)`,
    }
  }
  const slice = device.slices['cover']
  const positionable =
    device.features.includes(FEATURE_POSITIONABLE) || hasNumber(slice, 'position')
  const tilt = device.features.includes(FEATURE_TILT) || hasNumber(slice, 'tiltPosition')
  return {
    kind: 'publish',
    capabilities: [
      positionable ? positionCapability() : stateCapability(),
      ...(tilt ? [tiltCapability()] : []),
    ],
    category: coverCategoryFor(kind),
  }
}

/** The Alexa mode a lifecycle state maps to: a cover on its way reports where
 *  it is going (Amazon has no OPENING). */
export function modeForState(state: 'open' | 'opening' | 'closing' | 'closed' | 'stopped'): string {
  return state === 'closed' || state === 'closing' ? MODE_CLOSED : MODE_OPEN
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** The Alexa properties a `cover` slice sets. */
export function coverProperties(slice: unknown): readonly GenericProperty[] {
  const parsed = SliceShape.safeParse(slice)
  if (!parsed.success) return []
  const out: GenericProperty[] = []
  if (parsed.data.position !== null) {
    out.push({
      namespace: 'Alexa.RangeController',
      instance: INSTANCE_POSITION,
      name: 'rangeValue',
      value: clampPercent(parsed.data.position),
    })
  } else {
    out.push({
      namespace: 'Alexa.ModeController',
      instance: INSTANCE_STATE,
      name: 'mode',
      value: modeForState(parsed.data.state),
    })
  }
  if (parsed.data.tiltPosition !== null) {
    out.push({
      namespace: 'Alexa.RangeController',
      instance: INSTANCE_TILT,
      name: 'rangeValue',
      value: clampPercent(parsed.data.tiltPosition),
    })
  }
  return out
}

/** The slice fields the directive handlers read. */
export function readCoverSlice(
  slice: unknown,
): { state: string; position: number | null; tiltPosition: number | null } | null {
  const parsed = SliceShape.safeParse(slice)
  return parsed.success ? parsed.data : null
}
