/**
 * Turn the cap's normalized direction + magnitude into an ISAPI continuous
 * speed.
 *
 * The `ptz` cap splits the two: `pan`/`tilt`/`zoom` are a DIRECTION in -1..1,
 * and `speed` is the magnitude in 0..1. reolink maps them to Baichuan 1..63,
 * amcrest to Dahua 1..8 — and hikvision used to map them to nothing at all. It
 * dropped `speed` before it left the provider and handed the raw direction to
 * `/ISAPI/PTZCtrl/channels/{cam}/continuous`, whose `<pan>` is a speed
 * PERCENTAGE in -100..100.
 *
 * So `usePTZ` sending its d-pad default (`pan: 1, speed: 0.5`) reached the
 * dispensa camera as `<pan>1</pan>`: one percent of the camera's speed. A
 * request at less than half magnitude rounded to `0` and produced no motion at
 * all.
 *
 * An absent `speed` is mid-scale, never zero — reolink defaults to 32 of 63 for
 * the same reason. A caller who did not state a magnitude asked to move, not to
 * stand still.
 */
const MID_SCALE = 0.5

export function isapiSpeedFor(direction: number | undefined, speed: number | undefined): number {
  const d = direction ?? 0
  if (!Number.isFinite(d) || d === 0) return 0
  const magnitude = speed === undefined || !Number.isFinite(speed) ? MID_SCALE : Math.abs(speed)
  const percent = Math.round(Math.sign(d) * Math.min(1, Math.abs(d)) * Math.min(1, magnitude) * 100)
  return Math.max(-100, Math.min(100, percent))
}

/**
 * How long one `ptz.move` pulse runs on this driver.
 *
 * Hikvision has no absolute-step endpoint, only `/continuous`, so a discrete
 * move is a timed burst. The autotrack loop needs this number as the
 * DENOMINATOR of "how far did the head travel per pulse" — which is why it is
 * named here rather than left as a literal inside a `setTimeout`, where no
 * caller could ever read it.
 */
export const PTZ_MOVE_IMPULSE_MS = 500
