/**
 * A device's runs as the History view shows them: chart bands, panel rows and
 * the window a row opens. Pure: the caller supplies `now` and the text.
 *
 * A measurement that failed is `null` and reads `—`, never `0` (D393). An open
 * run extends to `now`.
 */
import type { DeviceRun, DeviceRunOutcome } from '@camstack/types'
import type { UiTextFn } from '../../contexts/ui-text'
import { formatDurationMs } from '../../lib/format-duration'
import type { ChartBand, ChartBandTone } from '../charts/chart-bands'
import type { HistoryWindow } from './history-window'

/** The context kept on each side of a run when a row opens it. */
export const RUN_WINDOW_MARGIN_MS: number = 15 * 60_000

/** The series whose chart carries the run bands. */
export const RUN_BANDS_SERIES_KEY = 'cap:power-meter.power'

export const NO_VALUE: string = '—'

export type RunStatus = DeviceRunOutcome | 'running'

export function runStatus(run: DeviceRun): RunStatus {
  return run.state === 'open' ? 'running' : (run.outcome ?? 'unknown')
}

export function runEnd(run: DeviceRun, now: number): number {
  return run.state === 'open' || run.endedAt === null ? now : run.endedAt
}

/** Elapsed time of a run; an open one counts up to `now`. `null` when a closed run has no duration. */
export function runDurationMs(run: DeviceRun, now: number): number | null {
  if (run.state === 'open') return Math.max(0, now - run.startedAt)
  if (run.durationMs !== null) return run.durationMs
  return run.endedAt === null ? null : Math.max(0, run.endedAt - run.startedAt)
}

export function formatKwh(kwh: number | null): string {
  return kwh === null ? NO_VALUE : `${kwh.toFixed(2)} kWh`
}

export function formatWatts(w: number | null): string {
  return w === null ? NO_VALUE : `${String(Math.round(w))} W`
}

export function formatRunDuration(ms: number | null): string {
  return ms === null ? NO_VALUE : formatDurationMs(ms)
}

const STATUS_TONE: Readonly<Record<RunStatus, ChartBandTone>> = {
  running: 'info',
  completed: 'success',
  aborted: 'warning',
  error: 'danger',
  unknown: 'neutral',
}

export function runTone(status: RunStatus): ChartBandTone {
  return STATUS_TONE[status]
}

/** The window that frames a run: the run plus {@link RUN_WINDOW_MARGIN_MS} each side. */
export function runWindow(run: DeviceRun, now: number): HistoryWindow {
  return {
    from: run.startedAt - RUN_WINDOW_MARGIN_MS,
    to: runEnd(run, now) + RUN_WINDOW_MARGIN_MS,
  }
}

/** One band per run that overlaps `window`; the label states the duration and the energy. */
export function runBands(
  runs: readonly DeviceRun[],
  now: number,
  window: HistoryWindow,
  t: UiTextFn,
): readonly ChartBand[] {
  const title = t('uiLibrary.history.runs.band', 'Run')
  return runs
    .filter((r) => runEnd(r, now) > window.from && r.startedAt < window.to)
    .map((r) => {
      const status = runStatus(r)
      const parts = [formatRunDuration(runDurationMs(r, now)), formatKwh(r.detail.energyKwh)]
      return {
        id: r.runId,
        from: r.startedAt,
        to: runEnd(r, now),
        title,
        label:
          status === 'running'
            ? t('uiLibrary.history.runs.bandRunning', 'running · {{parts}}', {
                parts: parts.join(' · '),
              })
            : parts.join(' · '),
        tone: runTone(status),
      }
    })
}
