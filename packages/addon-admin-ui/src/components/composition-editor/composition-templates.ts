/**
 * Draft templates for /build/compositions/new (design Q3): Room, Converted
 * sensor, Derived binary. They fill an EditorDraft; the operator still picks
 * real sources before save.
 */
import {
  DeviceType,
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  roomCompositionExample,
  type Composition,
  type CompositionFieldSource,
  type CompositionSourceRef,
} from '@camstack/types'
import { draftFromComposition, type EditorDraft, newDraft } from './draft-reducer'

export const COMPOSITION_TEMPLATE_IDS = ['room', 'converted-sensor', 'derived-binary'] as const
export type CompositionTemplateId = (typeof COMPOSITION_TEMPLATE_IDS)[number]

/** Placeholder source the Converted / Derived templates bind until the operator picks real ones. */
export const TEMPLATE_PLACEHOLDER_SOURCE: CompositionSourceRef = {
  addonId: 'provider-homeassistant',
  stableId: 'sensor.template_source',
}

export function roomTemplateDraft(): EditorDraft {
  const composition = roomCompositionExample({
    temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
    motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
    occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
  })
  return draftFromComposition(composition, 'Room')
}

export function convertedSensorTemplateDraft(): EditorDraft {
  const composition: Composition = {
    target: { kind: 'new', type: DeviceType.Sensor },
    features: [
      {
        kind: 'fields',
        cap: 'numeric-sensor',
        fields: {
          value: {
            kind: 'expression',
            expr: 'convert(v, "°C", "°F")',
            bindings: {
              v: {
                kind: 'from',
                source: TEMPLATE_PLACEHOLDER_SOURCE,
                cap: 'numeric-sensor',
                fieldPath: 'value',
              },
            },
          },
          unit: { kind: 'expression', expr: '"°F"', bindings: {} },
          lastFetchedAt: { kind: 'expression', expr: 'now', bindings: {} },
        },
      },
    ],
  }
  return draftFromComposition(composition, 'Converted sensor')
}

export function derivedBinaryTemplateDraft(): EditorDraft {
  const composition: Composition = {
    target: { kind: 'new', type: DeviceType.Sensor },
    features: [
      {
        kind: 'fields',
        cap: 'binary',
        fields: {
          on: {
            kind: 'expression',
            expr: 'v > 20',
            bindings: {
              v: {
                kind: 'from',
                source: TEMPLATE_PLACEHOLDER_SOURCE,
                cap: 'temperature-sensor',
                fieldPath: 'temperature',
              },
            },
          },
          lastChangedAt: { kind: 'expression', expr: 'now', bindings: {} },
        },
      },
    ],
  }
  return draftFromComposition(composition, 'Derived binary')
}

export interface CardFormulaTemplate {
  readonly id: CompositionTemplateId
  readonly cap: string
  readonly fieldPath: string
  readonly source: CompositionFieldSource
}

/** Ready-made formulas a card can insert on one field. The expression is the template's field, unchanged. */
export function formulaTemplatesFor(
  cap: string,
  fieldPath: string,
): readonly CardFormulaTemplate[] {
  const matches: CardFormulaTemplate[] = []
  for (const id of COMPOSITION_TEMPLATE_IDS) {
    const draft = compositionTemplateDraft(id)
    for (const feature of draft.features) {
      const source = feature.fields[fieldPath]
      if (feature.cap !== cap || source === undefined || source.kind !== 'expression') continue
      matches.push({ id, cap, fieldPath, source })
    }
  }
  return matches
}

export function compositionTemplateDraft(id: CompositionTemplateId): EditorDraft {
  switch (id) {
    case 'room':
      return roomTemplateDraft()
    case 'converted-sensor':
      return convertedSensorTemplateDraft()
    case 'derived-binary':
      return derivedBinaryTemplateDraft()
  }
}

/** Empty new draft of `deviceType` — the type step before features. */
export function typedNewDraft(deviceType: DeviceType): EditorDraft {
  return newDraft(deviceType)
}

/**
 * Where to land after createComposition. create returns only `block` (no
 * deviceId); when the composer later answers with a device id, prefer the
 * device page — otherwise stay on the editor.
 */
export function postCreateDestination(
  blockId: string,
  deviceId: number | null | undefined,
):
  | { readonly kind: 'device'; readonly path: string }
  | { readonly kind: 'editor'; readonly path: string } {
  if (typeof deviceId === 'number' && Number.isFinite(deviceId) && deviceId > 0) {
    return { kind: 'device', path: `/devices/${deviceId}` }
  }
  return { kind: 'editor', path: `/build/compositions/${encodeURIComponent(blockId)}` }
}
