/**
 * The drain line on a location card: how much is left, and when it will be
 * gone.
 *
 * Takes only the DERIVED state (`describeDrain`) and never a raw progress row,
 * so it renders identically whichever version of `LocationCard` hosts it and
 * every decision about what the numbers mean stays in `drain-progress.ts`.
 *
 * ## The bar goes UP
 *
 * A draining disk is the one place the capacity bar measures the wrong thing:
 * fill falls slowly and has no end in it. This bar is drain PROGRESS — the
 * share of the starting bytes that has left — so it fills as the disk empties
 * and reaching the right-hand edge means done. It is omitted entirely when the
 * fraction cannot be computed honestly (see `drainedFraction`), because a bar
 * pinned at zero reads as "nothing is happening" rather than "not known".
 *
 * ## Nothing is invented
 *
 * `estimatedEmptyAtMs` is null until the growth that paces the drain has been
 * observed, and the line says so in words. No placeholder date, no "soon", no
 * dash that could be mistaken for a value.
 */
import type { DrainDisplay } from './drain-progress'
import { useTranslation } from 'react-i18next'

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 100 * 1024 ** 3 ? 0 : 1)} GB` // i18n-ignore: SI unit symbol
}

/** Absolute and unambiguous: the operator is reading this to decide whether to
 *  wait. A relative "in 3 days" hides which side of a weekend it lands on. */
function formatEmptyAt(atMs: number): string {
  return new Date(atMs).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export function DrainProgressLine({ drain }: { readonly drain: DrainDisplay }) {
  const { t } = useTranslation()
  // Not draining — the card says nothing at all. An empty progress line on a
  // healthy location is noise the operator has to learn to ignore.
  if (drain.kind === 'idle') return null

  if (drain.kind === 'unreported') {
    return (
      <span
        data-testid="drain-unreported"
        className="text-[10px] text-foreground-subtle"
        title={t(
          'storage.drainProgressLine.thisLocationIsDrainingThe',
          'This location is draining. The hub has not reported how much is left yet — either the drain has just been set, or this hub predates the drain-progress report.',
        )}
      >
        {t(
          'storage.drainProgressLine.drainingRemainingNotReportedYet',
          'Draining · remaining not reported yet',
        )}
      </span>
    )
  }

  if (drain.kind === 'drained') {
    return (
      <span
        data-testid="drain-done"
        className="text-[10px] text-success"
        title={t(
          'storage.drainProgressLine.everythingThatWasHereHas',
          'Everything that was here has been moved. The location is still in drain mode — it receives no new writes until you change that.',
        )}
      >
        {t('storage.drainProgressLine.drainedNothingLeftToMove', 'Drained · nothing left to move')}
      </span>
    )
  }

  const percent = drain.drainedFraction === null ? null : Math.round(drain.drainedFraction * 100)
  return (
    <span
      data-testid="drain-progress"
      className="flex items-center gap-1.5 text-[10px] text-foreground-subtle tabular-nums"
    >
      {percent !== null && (
        <span
          data-testid="drain-bar"
          className="inline-block h-1 w-10 rounded-full bg-border overflow-hidden"
          role="progressbar"
          aria-label={t('storage.drainProgressLine.drainProgress', 'Drain progress')}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span className="block h-full bg-warning" style={{ width: `${percent}%` }} />
        </span>
      )}
      <span>
        {t('storage.drainProgressLine.left', { size: formatGb(drain.bytesRemaining) })}
        {percent !== null && ` · ${t('storage.drainProgressLine.moved', { percent })}`}
      </span>
      {drain.estimatedEmptyAtMs === null ? (
        <span
          data-testid="drain-eta-absent"
          title={t(
            'storage.drainProgressLine.theDrainIsPacedBy',
            'The drain is paced by how fast this class of data is still growing, and that has not been observed yet. There is no date to give.',
          )}
        >
          {t('storage.drainProgressLine.emptyTimeNotKnownYet', '· empty time not known yet')}
        </span>
      ) : (
        <span data-testid="drain-eta">
          ·{' '}
          {t('storage.drainProgressLine.empty', { when: formatEmptyAt(drain.estimatedEmptyAtMs) })}
        </span>
      )}
    </span>
  )
}
