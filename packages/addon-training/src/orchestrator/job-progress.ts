/**
 * Folding the trainer's output into a job record: `CAMSTACK_EVENT` lines move
 * the stage and the epoch series; every line (events included, compacted)
 * joins a bounded log tail. Providers never parse progress — this is the one
 * place that does, for every provider alike.
 */
import {
  parseTrainingEventLine,
  type TrainingJob,
  type TrainingLogLine,
  type TrainingProgressPoint,
} from '@camstack/types'

export const LOG_TAIL_LINES = 200
export const LOG_LINE_MAX_CHARS = 500
export const SERIES_MAX_POINTS = 300

type Progressed = Pick<TrainingJob, 'stage' | 'progress' | 'logTail'>

function clip(text: string): string {
  const line = text.replace(/\s+$/u, '')
  return line.length > LOG_LINE_MAX_CHARS ? `${line.slice(0, LOG_LINE_MAX_CHARS - 1)}…` : line
}

/** Provider log chunks may hold several lines, or half of one; split on newlines. */
export function splitLogLines(lines: readonly TrainingLogLine[]): string[] {
  return lines.flatMap((l) => l.text.split(/\r?\n/u)).filter((t) => t.trim().length > 0)
}

export function applyLogLines(job: Progressed, lines: readonly TrainingLogLine[]): Progressed {
  let stage = job.stage
  let epoch = job.progress.epoch
  let epochs = job.progress.epochs
  let etaSec = job.progress.etaSec
  const series: TrainingProgressPoint[] = [...job.progress.series]
  const tail: string[] = [...job.logTail]
  for (const text of splitLogLines(lines)) {
    tail.push(clip(text))
    const event = parseTrainingEventLine(text)
    if (event === null) continue
    if (event.type === 'stage') stage = event.stage
    if (event.type === 'epoch') {
      epoch = event.epoch
      epochs = event.epochs
      etaSec = event.etaSec ?? null
      const point: TrainingProgressPoint = {
        epoch: event.epoch,
        map50: event.map50 ?? null,
        map50_95: event.map50_95 ?? null,
      }
      const last = series.at(-1)
      if (last?.epoch === point.epoch) series[series.length - 1] = point
      else series.push(point)
    }
  }
  return {
    stage,
    progress: {
      epoch,
      epochs,
      etaSec,
      series: series.slice(-SERIES_MAX_POINTS),
    },
    logTail: tail.slice(-LOG_TAIL_LINES),
  }
}
