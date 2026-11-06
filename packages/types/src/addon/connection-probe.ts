/**
 * The probe behind an instance's Test action (D1016). It is NOT a capability: an addon builds one
 * and calls it from the `test` hook of its `integration-instances` provider, so
 * `integration-instances.testInstance` is the only way a connection is tested.
 *
 * The three outcomes are not interchangeable: `rejected` means the remote REFUSED the credentials
 * (observed); `inconclusive` means the check could not complete (DNS, timeout, an unexpected
 * shape) and nothing was observed. A probe that cannot tell a refusal from a transport fault
 * answers `inconclusive`: guessing `rejected` blocks a good create on a flaky network, guessing
 * `validated` waves a wrong password through.
 */

/** Ceiling on how long one probe may hold the form. */
export const CONNECTION_TEST_TIMEOUT_MS = 20_000

export type ConnectionTestOutcome =
  | {
      readonly outcome: 'validated'
      /** Round-trip of the sign-in, when the probe measured it. */
      readonly latencyMs?: number
      /** Human detail worth showing next to the tick ("3 devices visible on this account"). */
      readonly detail?: string
    }
  | { readonly outcome: 'rejected'; readonly error: string }
  | { readonly outcome: 'inconclusive'; readonly error: string }

/** The probe: candidate settings as the form collected them in, one outcome out; persists nothing. */
export interface IConnectionProbe {
  testSettings(input: {
    readonly settings: Readonly<Record<string, unknown>>
  }): Promise<ConnectionTestOutcome>
}
