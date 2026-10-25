/**
 * The three E2E suites in this directory drive a REAL inference engine
 * (`python+coreml`) against downloaded models. They are not unit tests and they
 * are not hermetic: `provider.init()` leaves the engine `idle` unless a
 * provisioned python environment exists on the machine, and the suite then dies
 * in `beforeAll` with `Detection engine not ready: idle`.
 *
 * They used to gate on `!process.env.CI`, which is backwards: it skipped them
 * on the one machine that could be made reproducible and ran them on every
 * developer laptop, where they have never passed. Three permanently-red files
 * in `npm run test` is worse than no coverage — it teaches everyone to read a
 * red suite as normal, and a real regression hides in that noise.
 *
 * So they are OPT-IN. Set `RUN_ENGINE_E2E=1` on a machine with the engine
 * provisioned; everywhere else the suite skips as a whole (hooks included),
 * which is what `describe.skipIf` does and what an unmet precondition deserves.
 *
 * This is a skip, not a deletion: the suites are the only thing that checks
 * detection output against `assets/reference-images/ground-truth`.
 */
export const ENGINE_E2E_ENABLED = process.env['RUN_ENGINE_E2E'] === '1'
