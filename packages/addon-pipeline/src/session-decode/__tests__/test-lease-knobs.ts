/**
 * The lease knobs a test session starts under.
 *
 * `WorkerRequest.lease` is REQUIRED (D453) — a `start` that names no knobs is a
 * configuration nobody decided — so every fake that drives the coordinator or
 * the pump has to supply one. This is the shipped default set, spelled out
 * rather than imported from `@camstack/types`, so a test that cares about a
 * particular knob overrides the field it cares about and a test that does not
 * is reading the same numbers production ships.
 */
import type { WorkerLeaseKnobs } from '../native-lease-knobs.js'

export const TEST_LEASE_KNOBS: WorkerLeaseKnobs = {
  values: {
    holdFrames: 8,
    budgetMb: 1024,
    activityMs: 15_000,
    admission: 'inferred',
    tileBudgetMb: 64,
    sceneBudgetMb: 48,
  },
  sources: {
    holdFrames: 'default',
    budgetMb: 'default',
    activityMs: 'default',
    admission: 'default',
    tileBudgetMb: 'default',
    sceneBudgetMb: 'default',
  },
}

/** The `lease` dep in the shape the coordinator and the pump take it. */
export const testLease = (): WorkerLeaseKnobs => TEST_LEASE_KNOBS
