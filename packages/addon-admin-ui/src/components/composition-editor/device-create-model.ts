/**
 * The Device section of the creation dialog (D1004): a built device is created
 * naked. Creation picks a type and, where the type needs it, the one thing
 * without which the device is meaningless. Facets attach later, in Customize.
 *
 *   media player  the media-player commands, forwarded to the picked source
 *                 when it exposes them, else naked (a remote is attached in
 *                 Customize, D964)
 *   anything else naked
 */
import {
  type Composition,
  type CompositionCommandTarget,
  type CompositionFeature,
  DeviceType,
  type HelperMember,
  mediaPlayerExtensionCommands,
  type SourcePickRequest,
} from '@camstack/types'

export const MEDIA_PLAYER_CAP = 'media-player'

/** What a type asks for at creation, besides a name. */
export type DeviceCreateNeed = 'none' | 'media-source'

export function createNeedOf(type: DeviceType): DeviceCreateNeed {
  // D1033 — a plug-in heater is no longer built: it is the plug itself, a
  // switch with the heater role, set in Customize.
  if (type === DeviceType.MediaPlayer) return 'media-source'
  return 'none'
}

/** The source picker's request for a type; `null` when the type picks nothing. */
export function sourceRequestOf(type: DeviceType): SourcePickRequest | null {
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

/** Every method the cap serves, each one a forward to the source. */
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
 * The composition a new device starts from. Every type can be created with
 * just a name (a media player's source is optional). No power metric, running
 * state or consumable is ever attached here.
 */
export function nakedComposition(type: DeviceType, source: HelperMember | null): Composition {
  const features: CompositionFeature[] =
    type === DeviceType.MediaPlayer ? mediaPlayerCommands(source) : []
  return { target: { kind: 'new', type }, features }
}
