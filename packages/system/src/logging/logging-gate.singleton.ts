/**
 * Process-wide holder for the {@link LoggingGate}.
 *
 * Two call sites that never meet need the SAME instance: `LogManager` reads it
 * on every emitted line, and the `system` cap provider — which `trpc.router.ts`
 * rebuilds PER REQUEST — refreshes it whenever the document is written. A gate
 * built inside that per-request factory would be refreshed and collected,
 * which is the shape of a knob that never does anything.
 *
 * Same idiom as `http-request-census.singleton.ts`.
 */

import { LoggingGate } from './logging-gate.js'

let instance: LoggingGate | null = null

/** The process-wide logging gate. Created unrestricted on first use. */
export function getLoggingGate(): LoggingGate {
  instance ??= new LoggingGate()
  return instance
}

/** Test-only: drop the instance so a spec starts from an unrestricted gate. */
export function __resetLoggingGateForTests(): void {
  instance = null
}
