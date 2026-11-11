/**
 * What the appliance and heater helper templates STORED (D944), frozen as test
 * fixtures for the `helper-to-customize` migration (D1004 phase 5). The live
 * template code is deleted; this is the one place that still builds the old
 * shape, so the migration is proved against what production rows really hold.
 * Never import it from product code.
 */
import {
  type Composition,
  CompositionSchema,
  type CompositionFieldSource,
  type HelperMember,
} from '@camstack/types'

export interface LegacyApplianceSpec {
  readonly kind: 'appliance'
  readonly templateId: 'appliance'
  readonly appliance: 'washer' | 'dryer' | 'dishwasher'
  readonly thresholdWatts: number
  readonly startDwellMs: number
  readonly stopDwellMs: number
  readonly member: HelperMember
  readonly powerSwitch?: HelperMember
  readonly offSeconds?: number
}

export interface LegacyHeaterSpec {
  readonly kind: 'heater'
  readonly templateId: 'heater'
  readonly plug: HelperMember
  readonly meter?: HelperMember
  readonly thresholdWatts: number
  readonly startDwellMs: number
  readonly stopDwellMs: number
}

type Bindings = Extract<CompositionFieldSource, { kind: 'expression' }>['bindings']

function expr(text: string, bindings: Bindings = {}): CompositionFieldSource {
  return { kind: 'expression', expr: text, bindings }
}

function readOf(member: HelperMember) {
  return {
    kind: 'from' as const,
    source: member.source,
    cap: member.cap,
    fieldPath: member.fieldPath,
  }
}

const CLOCK = expr('now')

function dwell(spec: {
  thresholdWatts: number
  startDwellMs: number
  stopDwellMs: number
}): string {
  return `dwell(x >= ${spec.thresholdWatts}, ${spec.startDwellMs}, ${spec.stopDwellMs})`
}

/**
 * `plain` is the composition without its `helper` spec (the live schema no
 * longer knows the appliance and heater kinds); `stored` is what the row held,
 * the `helper` spec included.
 */
export interface LegacyHelperComposition {
  readonly plain: Composition
  readonly stored: Record<string, unknown>
}

function parse(
  draft: { readonly helper: unknown } & Record<string, unknown>,
  storedTarget?: Record<string, unknown>,
): LegacyHelperComposition {
  const { helper, ...rest } = draft
  const plain = CompositionSchema.parse(rest)
  return { plain, stored: { ...plain, ...(storedTarget ? { target: storedTarget } : {}), helper } }
}

export function legacyAppliance(spec: LegacyApplianceSpec): LegacyHelperComposition {
  const read = readOf(spec.member)
  const d = dwell(spec)
  const powerSource =
    spec.powerSwitch === undefined
      ? []
      : [
          {
            kind: 'fields' as const,
            cap: 'power-source',
            fields: {
              switchOn: readOf(spec.powerSwitch),
              offSeconds: expr(String(spec.offSeconds ?? 10)),
              lastFetchedAt: CLOCK,
            },
          },
        ]
  return parse({
    target: { kind: 'new', type: spec.appliance },
    helper: spec,
    features: [
      {
        kind: 'fields',
        cap: 'running-state',
        fields: {
          running: expr(d, { x: read }),
          source: expr('"assigned"'),
          phase: expr('null'),
          lastFetchedAt: CLOCK,
          since: expr(`latchedAt(${d})`, { x: read }),
        },
      },
      { kind: 'fields', cap: 'power-meter', fields: { power: read, lastFetchedAt: CLOCK } },
      ...powerSource,
    ],
  })
}

export function legacyHeater(spec: LegacyHeaterSpec): LegacyHelperComposition {
  const plug = readOf(spec.plug)
  const meter = spec.meter === undefined ? undefined : readOf(spec.meter)
  const d = dwell(spec)
  // The row stored the retired `heater` type; the live shape is a switch with
  // the heater role (D1033), which is what the migration must produce.
  return parse(
    {
      target: { kind: 'new', type: 'switch', role: 'switch-heater' },
      helper: spec,
      features: [
        {
          kind: 'fields',
          cap: 'switch',
          fields: { on: plug, lastChangedAt: CLOCK },
          commands: {
            setState: {
              kind: 'forward',
              source: spec.plug.source,
              cap: 'switch',
              method: 'setState',
            },
          },
        },
        {
          kind: 'fields',
          cap: 'running-state',
          fields: {
            running: meter === undefined ? expr('x', { x: plug }) : expr(d, { x: meter }),
            source: expr('"assigned"'),
            phase: expr('null'),
            lastFetchedAt: CLOCK,
            since:
              meter === undefined
                ? expr('latchedAt(x)', { x: plug })
                : expr(`latchedAt(${d})`, { x: meter }),
          },
        },
        ...(meter === undefined
          ? []
          : [
              {
                kind: 'fields' as const,
                cap: 'power-meter',
                fields: { power: meter, lastFetchedAt: CLOCK },
              },
            ]),
      ],
    },
    { kind: 'new', type: 'heater' },
  )
}
