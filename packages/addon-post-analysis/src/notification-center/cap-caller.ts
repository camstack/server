/**
 * The identity a `caller: 'required'` cap method was promised — or a sentence
 * naming who broke the promise.
 *
 * The capability contract reads: "the hub cap-router injects a server-derived
 * `CapCaller` into the input object handed to the provider ... and fails the
 * call with UNAUTHORIZED when the context carries no authenticated user", and
 * `InferProvider` types the field as PRESENT. That guarantee holds on the tRPC
 * edge, where there is a session behind the call.
 *
 * It does not hold for an ADDON→ADDON cap call. An addon is not a user, so
 * `caller` arrives `undefined` while the provider's type still insists it is
 * there, and the first property access ends the call with
 * `Cannot read properties of undefined (reading 'userId')` — a message that
 * names neither the method, nor the caller, nor the reason. Measured on the
 * live hub from 2026-08-26 21:55: roughly 140 lines an hour, all of them the
 * export addon's `listSnoozes` read, and unreadable every single time.
 *
 * This helper GRANTS nothing. An addon still cannot read caller-scoped data —
 * that is the correct answer, and the export's snooze selects going `unknown`
 * is the honest consequence. It only makes the refusal legible, so the next
 * reader sees a contract being enforced instead of a null-pointer crash.
 */
import type { CapCaller } from '@camstack/types'

export function requireCapCaller(method: string, caller: CapCaller | undefined): CapCaller {
  if (caller === undefined || typeof caller.userId !== 'string' || caller.userId.length === 0) {
    throw new Error(
      `notification-rules.${method} declares caller: 'required' and this call carried no ` +
        `caller identity — an addon-to-addon cap call has no authenticated user`,
    )
  }
  return caller
}
