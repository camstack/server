/**
 * A remote attached to a NAKED built media player (D1004 point 4, D964). The
 * device has no `media-player` feature, so nothing would answer a media command
 * for the remote's bindings to run. Saving the remote adds the feature with
 * every command served by the `remote` extension; a built player that already
 * has the feature (forwarded from its source, or already an extension) is left
 * alone.
 */
import {
  COMPOSED_DEVICE_STABLE_ID_PREFIX,
  type Composition,
  type DeviceInfo,
  mediaPlayerExtensionCommands,
} from '@camstack/types'

const MEDIA_PLAYER_CAP = 'media-player'

/** The block behind a built device; `null` for a native device. */
export function composedBlockIdOf(device: Pick<DeviceInfo, 'stableId'>): string | null {
  return device.stableId.startsWith(COMPOSED_DEVICE_STABLE_ID_PREFIX)
    ? device.stableId.slice(COMPOSED_DEVICE_STABLE_ID_PREFIX.length)
    : null
}

/** The composition with the extension-served `media-player` feature, or `null` when nothing is to add. */
export function withMediaPlayerExtension(composition: Composition): Composition | null {
  if (composition.target.kind !== 'new') return null
  if (composition.features.some((feature) => feature.cap === MEDIA_PLAYER_CAP)) return null
  return {
    ...composition,
    features: [
      ...composition.features,
      {
        kind: 'fields',
        cap: MEDIA_PLAYER_CAP,
        fields: {},
        commands: mediaPlayerExtensionCommands(),
      },
    ],
  }
}
