/**
 * The zone assert (D549 7).
 *
 * Every recording timestamp Baichuan carries is the camera's wall clock with
 * no offset. The provider therefore NAMES the zone it reads them with, and
 * checks once per device that the camera's own clock agrees. The container
 * runs `TZ=Europe/Berlin` and these cameras happen to match it — by
 * CONFIGURATION, not by design — and a silent one-hour skew puts a clip in the
 * wrong hour, a clip near midnight in the wrong DAY, and a day-index lookup on
 * the wrong calendar entry.
 *
 * The check never blocks a listing: a mismatch is a warn per device and the
 * catalog still lists, because a camera whose clock is wrong still has clips
 * and the operator needs to see them to know something is wrong.
 *
 * A camera that reported NO clock answers `agrees: null`. Unknown is not
 * agreement — folding "we could not read it" into "it matches" is exactly the
 * substitution that makes a skew invisible.
 */

/** The camera's own reading of its wall clock (`getSystemGeneral`). */
export interface CameraClock {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

export interface CompareCameraClockInput {
  readonly clock: CameraClock | null
  /** The instant the clock was read, by OUR clock. */
  readonly atMs: number
  /** The zone the provider is reading recordings with. */
  readonly timeZone: string
}

export interface CameraClockComparison {
  /** `null` when the camera reported no clock — unknown, never agreement. */
  readonly agrees: boolean | null
  /** Camera minus us, in ms. Negative means the camera is behind. */
  readonly skewMs: number
  readonly cameraWallClock: string
  readonly assumedWallClock: string
  readonly timeZone: string
}

/**
 * How far the camera's clock may differ before it is a zone problem rather
 * than drift. Two minutes: NTP drift on these cameras is seconds, and the
 * smallest zone error is a whole hour.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 120_000

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

function formatClock(clock: CameraClock): string {
  return `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)} ${pad(clock.hour)}:${pad(clock.minute)}:${pad(clock.second)}`
}

/** What the wall clock in `timeZone` reads at `atMs`, in the same format. */
function wallClockIn(atMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(atMs))
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type)
    return found === undefined ? 0 : Number(found.value)
  }
  return formatClock({
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  })
}

export function compareCameraClock(input: CompareCameraClockInput): CameraClockComparison {
  const assumed = wallClockIn(input.atMs, input.timeZone)
  if (input.clock === null) {
    return {
      agrees: null,
      skewMs: 0,
      cameraWallClock: '',
      assumedWallClock: assumed,
      timeZone: input.timeZone,
    }
  }
  const cameraWallClock = formatClock(input.clock)
  // Both readings name a wall clock; compare them as naive instants, which is
  // exactly the comparison a zone error breaks.
  const asNaive = (text: string): number => Date.parse(`${text.replace(' ', 'T')}Z`)
  const skewMs = asNaive(cameraWallClock) - asNaive(assumed)
  return {
    agrees: Math.abs(skewMs) <= CLOCK_SKEW_TOLERANCE_MS,
    skewMs,
    cameraWallClock,
    assumedWallClock: assumed,
    timeZone: input.timeZone,
  }
}
