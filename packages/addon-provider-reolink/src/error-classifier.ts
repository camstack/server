/**
 * Recognise transient Baichuan/socket failures that are expected to
 * recover on the next reconnect cycle — the same wire-level conditions
 * are always treated the same way.
 *
 * Categories:
 *   - Baichuan-specific transport closes (`Baichuan socket closed`,
 *     `Baichuan UDP stream closed`, `Baichuan TCP socket is not
 *     connected`)
 *   - Generic TCP errors that fire as part of the same disconnect
 *     storm (`ECONNRESET`, `EPIPE`, `socket hang up`)
 *   - D2C disconnects (`D2C_DISC`) — UDP relay path teardown
 *
 * Callers downgrade these to WARN-level logs and trigger a fresh
 * login on the next demand instead of bubbling a hard ERROR.
 */
const RECOVERABLE_FRAGMENTS: ReadonlyArray<string> = [
  'Baichuan socket closed',
  'Baichuan UDP stream closed',
  'Baichuan TCP socket is not connected',
  'socket hang up',
  'ECONNRESET',
  'EPIPE',
  'D2C_DISC',
]

export function isRecoverableBaichuanError(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : ((err as { toString?: () => string })?.toString?.() ?? '')
  return RECOVERABLE_FRAGMENTS.some((fragment) => message.includes(fragment))
}
