/**
 * Shared stream label utilities for the admin UI.
 *
 * Wraps `streamQualityLabel` from `@camstack/types` and adds
 * context-aware formatting (resolution, quality suffix).
 *
 * Contexts:
 *   - `short`   → "High", "Mid", "Low"
 *   - `quality` → "High Quality", "Mid Quality", "Low Quality"
 *   - `broker`  → "High (1920×1080)", includes resolution when available
 */
import { streamQualityLabel } from '@camstack/types'
import i18n from '../../i18n/index'

export type StreamLabelContext = 'short' | 'quality' | 'broker'

/** Get a friendly label for a stream ID. */
export function streamLabel(
  id: string,
  context: StreamLabelContext = 'short',
  resolution?: { width: number; height: number } | null,
): string {
  const base = streamQualityLabel(id)

  if (context === 'quality') {
    return i18n.t('helpers.streamLabels.quality', { base })
  }
  if (context === 'broker' && resolution) {
    return `${base} (${resolution.width}×${resolution.height})`
  }
  return base
}
