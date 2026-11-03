/**
 * The Device section of the creation dialog (D1004): a built device is created
 * naked. Creation picks a type and, where the type needs it, the one thing
 * without which the device is meaningless. Facets attach later, in Customize.
 *
 *   media player  the media-player commands, forwarded to the picked source
 *                 when it exposes them, else naked (a remote is attached in
 *                 Customize, D964)
 *   heater        the plug it switches: on/off forward to it
 *   anything else naked
 */
import {
  type Composition,
  type CompositionCommandTarget,
  type CompositionFeature,
  type CompositionFieldSource,
  DeviceType,
  type HelperMember,
  mediaPlayerExtensionCommands,
  type SourcePickRequest,
  sourcePickForHeaterPlug,
} from '@camstack/types'

export const MEDIA_PLAYER_CAP = 'media-player'

/** What a type asks for at creation, besides a name. */
export type DeviceCreateNeed = 'none' | 'media-source' | 'control-source'

export function createNeedOf(type: DeviceType): DeviceCreateNeed {
  if (type === DeviceType.MediaPlayer) return 'media-source'
  if (type === DeviceType.Heater) return 'control-source'
  return 'none'
}

/** The source picker's request for a type; `null` when the type picks nothing. */
export function sourceRequestOf(type: DeviceType): SourcePickRequest | null {
  if (type === DeviceType.Heater) return sourcePickForHeaterPlug()
  if (type !== DeviceType.MediaPlayer) return null
  return {
    fieldChoice: 'operator',
    purpose: 'member',
    multiple: false,
    max: 1,
    deviceTypes: [DeviceType.MediaPlayer],
    accept: [{ cap: MEDIA_PLAYER_CAP, fieldPath: 'state', valueKind: 'state' }],
    history: { required: false, minRetentionMs: null },
    mustBindCaps: [MEDIA_PLAYER_CAP],
    exclude: [],
  }
}

/** A heater cannot be created before its plug is named; every other type can. */
export function canCreate(type: DeviceType, source: HelperMember | null): boolean {
  return type !== DeviceType.Heater || (source !== null && source.cap === 'switch')
}

const CLOCK: CompositionFieldSource = { kind: 'expression', expr: 'now', bindings: {} }

function heaterControl(plug: HelperMember): CompositionFeature {
  return {
    kind: 'fields',
    cap: 'switch',
    fields: {
      on: { kind: 'from', source: plug.source, cap: plug.cap, fieldPath: plug.fieldPath },
      lastChangedAt: CLOCK,
    },
    commands: {
      setState: { kind: 'forward', source: plug.source, cap: 'switch', method: 'setState' },
    },
  }
}

/** Every method the cap serves, each one a forward to the source (the heater's mechanism). */
function mediaPlayerCommands(source: HelperMember | null): CompositionFeature[] {
  if (source === null || source.cap !== MEDIA_PLAYER_CAP) return []
  const commands: Record<string, CompositionCommandTarget> = Object.fromEntries(
    Object.keys(mediaPlayerExtensionCommands()).map((method) => [
      method,
      { kind: 'forward', source: source.source, cap: MEDIA_PLAYER_CAP, method } as const,
    ]),
  )
  return [{ kind: 'fields', cap: MEDIA_PLAYER_CAP, fields: {}, commands }]
}

/**
 * The composition a new device starts from, or `null` while the type still
 * lacks what it needs. No power metric, running state or consumable is ever
 * attached here.
 */
export function nakedComposition(
  type: DeviceType,
  source: HelperMember | null,
): Composition | null {
  if (!canCreate(type, source)) return null
  const features: CompositionFeature[] =
    type === DeviceType.Heater && source !== null
      ? [heaterControl(source)]
      : type === DeviceType.MediaPlayer
        ? mediaPlayerCommands(source)
        : []
  return { target: { kind: 'new', type }, features }
}
