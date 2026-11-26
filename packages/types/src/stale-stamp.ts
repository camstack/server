/**
 * The concurrency stamp of a Customize record (D1098): a save carries the stamp
 * it READ, and a record changed since is refused by name — last-write-wins would
 * drop the other admin's edit without a word. The code leads the message
 * (`[stale-stamp] …`) because a cap call flattens an error to its text.
 */
export const STALE_STAMP_CODE = 'stale-stamp'

export class StaleStampError extends Error {
  readonly code = STALE_STAMP_CODE
  readonly record: string
  readonly stored: number
  readonly expected: number

  constructor(record: string, stored: number, expected: number) {
    super(
      `[${STALE_STAMP_CODE}] ${record} changed since you read it: stored stamp ${stored}, yours ${expected} — reload and re-apply your edit`,
    )
    this.name = 'StaleStampError'
    this.record = record
    this.stored = stored
    this.expected = expected
  }
}
