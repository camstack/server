/**
 * Process-wide holder for the HTTP request census.
 *
 * Two call sites that never meet need the SAME instance: `main.ts` counts into
 * it from the tRPC context factory and the WS handler, and the `system` cap
 * provider - which `trpc.router.ts` rebuilds PER REQUEST - arms and reads it.
 * A census built inside that per-request factory would count one request and
 * be collected, which is the shape of an instrument that reports zero forever.
 *
 * Same idiom as `lifecycle-runner.singleton.ts`, minus the init step: this one
 * has no dependencies, so the first reader creates it disarmed.
 */

import { HttpRequestCensus } from './http-request-census.js'

let instance: HttpRequestCensus | null = null

/** The process-wide census. Created disarmed on first use. */
export function getHttpRequestCensus(): HttpRequestCensus {
  instance ??= new HttpRequestCensus()
  return instance
}

/** Test-only: drop the instance so a spec starts from a disarmed census. */
export function __resetHttpRequestCensusForTests(): void {
  instance = null
}
