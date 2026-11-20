/** Which push mechanism the camera was armed with. */
export type EventPushMechanism = 'webhook' | 'email'

export type EventPushOnAddOutcome =
  | { readonly status: 'configured'; readonly mechanism: EventPushMechanism }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string }

export type BatterySleepPushMethod = 'auto' | 'webhook' | 'email'

export interface EventPushOnAddPorts {
  /** The per-camera option "Auto-configure event push on add" (default on). */
  enabled(): boolean
  /** The outcome recorded by a previous run, when there is one. */
  recordedOutcome(): string | undefined
  /** A hub-attached camera has no push configuration of its own. */
  isEligible(): boolean
  /** The HaCfg webhook exists only on standalone battery cameras. */
  isBattery(): boolean
  method(): BatterySleepPushMethod
  configureWebhook(): Promise<void>
  configureEmail(): Promise<void>
  /** Persist that the run happened, so a restart never writes the camera again. */
  record(outcome: EventPushOnAddOutcome): Promise<void>
  log(outcome: EventPushOnAddOutcome): void
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function decide(ports: EventPushOnAddPorts): Promise<EventPushOnAddOutcome> {
  if (!ports.enabled()) {
    return { status: 'skipped', reason: 'auto-configure event push on add is switched off' }
  }
  if (!ports.isEligible()) {
    return {
      status: 'skipped',
      reason: 'hub-attached camera: the hub owns its event push, no email or webhook is written',
    }
  }
  const method = ports.method()
  const webhookPossible = ports.isBattery() && method !== 'email'
  const failures: string[] = []
  if (webhookPossible) {
    try {
      await ports.configureWebhook()
      return { status: 'configured', mechanism: 'webhook' }
    } catch (err) {
      failures.push(`webhook: ${reasonOf(err)}`)
      if (method === 'webhook') return { status: 'failed', reason: failures.join('; ') }
    }
  } else if (method === 'webhook') {
    return {
      status: 'skipped',
      reason: 'the webhook needs a standalone battery camera and this one is not',
    }
  }
  try {
    await ports.configureEmail()
    return { status: 'configured', mechanism: 'email' }
  } catch (err) {
    failures.push(`email: ${reasonOf(err)}`)
    return { status: 'failed', reason: failures.join('; ') }
  }
}

/**
 * Arm a camera's local event push ONCE, right after it is added. A failure is an outcome, never
 * a throw: it must not block the add. The outcome is logged and recorded, and a recorded camera
 * is never written again. Battery cameras prefer the webhook (it works while asleep) and fall back
 * to the camera mailbox; only one path is armed, so events are not delivered twice.
 */
export async function autoConfigureEventPushOnce(
  ports: EventPushOnAddPorts,
): Promise<EventPushOnAddOutcome | 'already-ran'> {
  if (ports.recordedOutcome() !== undefined) return 'already-ran'
  const outcome = await decide(ports)
  ports.log(outcome)
  try {
    await ports.record(outcome)
  } catch (err) {
    ports.log({ status: 'failed', reason: `could not record the run: ${reasonOf(err)}` })
  }
  return outcome
}
