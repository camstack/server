import { errMsg, type IScopedLogger } from '@camstack/types'

export interface RetireReprobeInput {
  readonly deviceId: number
  /** True once the box has answered at least one poll. */
  readonly hasSnapshot: () => boolean
  /** Subscribe to the integration's snapshots; returns the unsubscribe. */
  readonly onSnapshot: (listener: () => void) => () => void
  /** The kernel's reprobe: re-reads the declared children and reconciles them. */
  readonly reprobe: () => Promise<void>
  readonly logger: IScopedLogger
}

/**
 * A child the catalog stopped declaring is deleted by the kernel only on a SECOND agreeing
 * read of a later probe (D49). The box devices probe once, at registration, so without this
 * a retired child would stay until something else re-probed. One reprobe per activation,
 * once the box has answered (the kernel treats an offline parent's read as unknown): it is
 * bounded, costs one declared-children read, and is a no-op when nothing is retired.
 */
export function armRetireReprobe(input: RetireReprobeInput): () => void {
  let fired = false
  let unsubscribe: (() => void) | null = null
  const fire = (): void => {
    if (fired) return
    fired = true
    unsubscribe?.()
    unsubscribe = null
    input.reprobe().catch((err: unknown) => {
      input.logger.warn('enpal: reprobe after activation failed — retired children wait', {
        tags: { deviceId: input.deviceId },
        meta: { error: errMsg(err) },
      })
    })
  }
  if (input.hasSnapshot()) {
    fire()
    return () => undefined
  }
  unsubscribe = input.onSnapshot(() => {
    // A tick also reports a failed poll: only an answered one is a readable parent.
    if (input.hasSnapshot()) fire()
  })
  return () => {
    unsubscribe?.()
    unsubscribe = null
  }
}
