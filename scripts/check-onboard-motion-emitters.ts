#!/usr/bin/env tsx
/**
 * GUARD: only the camera-sensors bridge, the device-activity source and the
 * runner's analyzer emit `MotionOnMotionChanged` (D673), and only the
 * orchestrator writes a camera's `motion` runtime slice (D696). The rules live in
 * `onboard-motion-emitters-guard.ts`; `scripts/__tests__/check-onboard-motion-emitters.spec.ts`
 * proves each red on a fixture and green on the real tree. A deferred emitter
 * is a named exception with a reason, listed in the output.
 *
 * Usage: tsx scripts/check-onboard-motion-emitters.ts
 */
import {
  checkHubMotionReadFacts,
  checkMotionSliceWriterFacts,
  checkOnboardMotionEmitterFacts,
  checkStaleExemptionFacts,
  checkStaleSliceExemptionFacts,
  collectOnboardMotionFiles,
  MOTION_EMITTERS_DEFERRED,
  MOTION_SLICE_SENSOR_WRITERS,
} from './onboard-motion-emitters-guard.ts'

function main(): void {
  const files = collectOnboardMotionFiles()
  const failures = [
    ...checkOnboardMotionEmitterFacts(files),
    ...checkStaleExemptionFacts(files),
    ...checkMotionSliceWriterFacts(files),
    ...checkStaleSliceExemptionFacts(files),
    ...checkHubMotionReadFacts(files),
  ]
  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('check-onboard-motion-emitters: FAILED\n')
    // eslint-disable-next-line no-console
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(
    `check-onboard-motion-emitters: OK — ${files.length} source files; three motion emitters, ${MOTION_EMITTERS_DEFERRED.size} deferred; one camera motion-slice writer, ${MOTION_SLICE_SENSOR_WRITERS.size} sensor slice writers; camera motion reads via hubMotionNativeProvider`,
  )
  for (const [rel, reason] of MOTION_EMITTERS_DEFERRED) {
    // eslint-disable-next-line no-console
    console.log(`  deferred: ${rel} — ${reason}`)
  }
}

main()
