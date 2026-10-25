/**
 * Palette entry ids (D939). Audio is the one gradient; `audio-*` leaves are
 * not entries. `heatmapScrub` is a mark, not an event kind.
 */

export const PALETTE_ENTRY_IDS = [
  'motion',
  'audio',
  'recording',
  'live',
  'heatmapScrub',
  'person',
  'vehicle',
  'animal',
  'package',
  'sensor',
  'control',
  'face',
  'plate',
  'car',
  'truck',
  'bus',
  'motorcycle',
  'bicycle',
  'airplane',
  'boat',
  'train',
  'bird',
  'dog',
  'cat',
  'horse',
  'sheep',
  'cow',
  'elephant',
  'bear',
  'zebra',
  'giraffe',
  'package-delivered',
  'package-picked-up',
  'suitcase',
  'backpack',
  'handbag',
  'contact',
  'motion-sensor',
  'smoke',
  'flood',
  'gas',
  'carbon-monoxide',
  'vibration',
  'tamper',
  'presence',
  'enum-sensor',
  'device-event',
  'lock',
  'cover',
  'switch',
  'siren',
  'button',
  'doorbell',
] as const

export type PaletteEntryId = (typeof PALETTE_ENTRY_IDS)[number]

export const AUDIO_ENTRY_ID = 'audio'
export const AUDIO_LEAF_PREFIX = 'audio-'

/** Six rungs, quiet → loud. The opaque end is the entry's hex. */
export const AUDIO_GRADIENT_ALPHAS = [0.3, 0.42, 0.55, 0.7, 0.85, 1] as const

export const PALETTE_FALLBACK_COUNT = 8

export const PALETTE_PRESET_IDS = ['camstack', 'high-contrast', 'okabe-ito'] as const

export type PalettePresetId = (typeof PALETTE_PRESET_IDS)[number]

export function isPaletteEntryId(id: string): id is PaletteEntryId {
  return (PALETTE_ENTRY_IDS as readonly string[]).includes(id)
}

export function isPalettePresetId(id: string): id is PalettePresetId {
  return (PALETTE_PRESET_IDS as readonly string[]).includes(id)
}
