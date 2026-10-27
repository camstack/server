import type { StationaryObjectRegistry } from '../stationary-registry.js'

/** Feed a continuous stream of processed frames, `stepMs` apart, from `from`
 *  to `to` inclusive. Expiry counts WATCHED time, so a test that means "the
 *  camera watched for N ms" must deliver frames, not jump the clock. */
export function watchFrames(
  reg: StationaryObjectRegistry,
  deviceId: number,
  from: number,
  to: number,
  stepMs = 1_000,
): void {
  for (let t = from; t < to; t += stepMs) reg.noteFrame(deviceId, t)
  reg.noteFrame(deviceId, to)
}
