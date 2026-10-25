/**
 * The `recorder` / `exports` handle every export spec runs against.
 *
 * Uses the REAL records facade over an in-memory transport, so the kind
 * semantics (at: required, device index, etc.) are enforced the same way the
 * engine does — mirrors the pipeline-analytics and orchestrator fixtures.
 */
import type { RecordingExportsState } from '../export-store.js'
import { recordingExportsState } from '../export-store.js'
import { makeRecorderRecords } from './fake-records.js'

/** A declared, empty `recorder` / `exports` on a fresh in-memory records world. */
export async function makeExportsState(): Promise<RecordingExportsState> {
  const world = await makeRecorderRecords()
  return recordingExportsState(world.records)
}
