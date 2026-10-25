/**
 * Pure helpers for the HLS playback quality selector.
 *
 * Intentionally decoupled from hls.js types so this module can be
 * imported and tested without a DOM or MSE environment.
 */
import { defaultUiText, type UiTextFn } from '../contexts/ui-text'

export interface QualityOption {
  readonly value: number
  readonly label: string
}

export interface HlsLevelInfo {
  readonly height?: number
  readonly bitrate?: number
  readonly name?: string
}

/**
 * Build a human-readable label for a single HLS level.
 *
 * Priority:
 * 1. `name` (non-empty) → verbatim. The recorder stamps the master variant
 *    NAME with the recording profile (high/mid/low), and the VOD selector must
 *    match the live stream-profile selector's labels — the profile name wins
 *    over resolution/bitrate.
 * 2. `height` (> 0) → e.g. "1080p"
 * 3. `bitrate` (> 0) → e.g. "2500 kbps"
 * 4. Fallback → "Level N" (1-based)
 */
export function levelLabel(
  level: HlsLevelInfo,
  index: number,
  t: UiTextFn = defaultUiText,
): string {
  if (level.name !== undefined && level.name.length > 0) {
    return level.name
  }
  if (level.height !== undefined && level.height > 0) {
    return `${level.height}p`
  }
  if (level.bitrate !== undefined && level.bitrate > 0) {
    // i18n-ignore: unit symbol
    return `${Math.round(level.bitrate / 1000)} kbps`
  }
  return t('uiLibrary.hlsQuality.level', 'Level {{n}}', { n: index + 1 })
}

/**
 * Build the full list of quality options for the selector overlay.
 *
 * Always starts with the Auto entry (`value: -1`), followed by one
 * entry per available HLS level in manifest order.
 */
export function qualityOptions(
  levels: readonly HlsLevelInfo[],
  t: UiTextFn = defaultUiText,
): QualityOption[] {
  const auto: QualityOption = { value: -1, label: t('uiLibrary.hlsQuality.auto', 'Auto') }
  const levelEntries: QualityOption[] = levels.map((l, i) => ({
    value: i,
    label: levelLabel(l, i, t),
  }))
  return [auto, ...levelEntries]
}
