/**
 * WHICH detection planes carry the stationary machinery.
 *
 * A plane qualifies when it produces OBJECT BOXES on decoded frames — because
 * that is what the registry needs to decide an object is parked: a box, a
 * class, and an observed clock that only advances while frames flow.
 *
 * Both root detectors qualify. `pipeline` is the ML tree; `onboard` is the
 * camera's own firmware, and the boxes it produces are paired with a decoded
 * frame in that frame's pixel space — the same plane, entered by a different
 * door. `sensor` and `audio` do not: they carry no geometry to park.
 *
 * It used to be `source === 'pipeline'`, in five places, each explaining that
 * the gate "runs on that plane". The reason given was WHERE the flood it was
 * written for had been measured (102, the ML plane), never an argument that the
 * firmware's boxes were unfit. The cost of the accident, on device 106: a still
 * object is never promoted, so it holds `hasLiveTrack` true for as long as it
 * sits there, and every detection session runs to its 120 s cap instead of
 * closing on cooldown — `closed at the max-hold cap with a subject still
 * present`. The camera's lazy stream is then torn down and rebuilt on the next
 * detection, on a battery camera.
 *
 * One predicate and not five comparisons, because five copies of a rule drift:
 * this repo has already paid for that with two authorities on one function
 * (D62).
 */

/** Does this detection plane run the stationary registry, gate and promotion? */
export function planeRunsStationary(source: string): boolean {
  return source === 'pipeline' || source === 'onboard'
}
