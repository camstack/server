/**
 * How long something lasted, the way this product says it.
 *
 * Promoted verbatim from `composites/cap-settings/RecordingPanel.tsx`, which
 * had been the only place answering this question about MEDIA. It is now the
 * only place, so a clip's length and a recording's retention read the same.
 *
 * Two other private formatters stay where they are, on purpose:
 * `config-form-field.tsx` formats a config VALUE (sub-second `ms`, `—` for a
 * value that is not a number), and `scene-monitor-copy.ts`'s `humanDuration`
 * is deliberately single-unit and coarse for a sentence. Neither is a media
 * length, and folding them in here would change what they say.
 */
export function formatDurationMs(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
