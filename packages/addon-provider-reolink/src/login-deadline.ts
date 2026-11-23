/**
 * A login the camera abandons must not wedge the provider.
 *
 * `ensureApi` is single-flight: every caller joins the pending `loginPromise`.
 * A camera that accepts the connection and then never answers left that
 * promise pending forever, so every later demand joined a login that could
 * not finish and the provider stayed dark until a restart.
 */

/** Longest a Baichuan login may take before it is abandoned (a battery wake included). */
export const LOGIN_DEADLINE_MS = 60_000

export class LoginDeadlineError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`Baichuan login did not finish within ${deadlineMs} ms`)
    this.name = 'LoginDeadlineError'
  }
}

/**
 * Run `login`, bounded. On expiry `onExpire` closes the pending client, then
 * the call rejects with {@link LoginDeadlineError}; a late settle of `login` is
 * swallowed (the client it belonged to is closed).
 */
export async function loginWithin(
  login: () => Promise<void>,
  deadlineMs: number,
  onExpire: () => Promise<void> | void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void Promise.resolve()
        .then(onExpire)
        .catch(() => undefined)
        .then(() => reject(new LoginDeadlineError(deadlineMs)))
    }, deadlineMs)
  })
  const run = login()
  run.catch(() => undefined)
  try {
    await Promise.race([run, expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
