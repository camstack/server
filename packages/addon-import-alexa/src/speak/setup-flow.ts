/** Setup screen the operator is on. The page renders one of these; it does not invent a fifth. */

export type SetupPhase = 'sign-in' | 'otp' | 'captcha' | 'devices'

export type SetupEvent =
  | { readonly type: 'login'; readonly status: 'ok' | 'otp_needed' | 'captcha' | 'failed' }
  | { readonly type: 'otp'; readonly status: 'ok' | 'otp_needed' | 'captcha' | 'failed' }
  | { readonly type: 'reset' }

/** Where the next screen is. A failed password stays on sign-in. A failed code stays on the code step. */
export function reduceSetup(phase: SetupPhase, event: SetupEvent): SetupPhase {
  if (event.type === 'reset') return 'sign-in'
  if (event.status === 'ok') return 'devices'
  if (event.status === 'otp_needed') return 'otp'
  if (event.status === 'captcha') return 'captcha'
  return phase
}
