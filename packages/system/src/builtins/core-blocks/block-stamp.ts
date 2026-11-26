/**
 * The stamp check of a core block write (D1098). A save carries the `updatedAt` it read; when the
 * stored block moved since, the write is refused with a typed error rather than overwriting the
 * other editor's change. A caller that sends no stamp (a script, an internal re-expansion) is not
 * checked, and a block that is gone falls through to the store, whose own refusal names it.
 */
import { type CoreBlock, StaleStampError } from '@camstack/types'

export function staleBlockRefusal(
  stored: Pick<CoreBlock, 'name' | 'updatedAt'> | null,
  expectedUpdatedAt: number | undefined,
): StaleStampError | null {
  if (expectedUpdatedAt === undefined || stored === null) return null
  if (stored.updatedAt === expectedUpdatedAt) return null
  return new StaleStampError(`the block "${stored.name}"`, stored.updatedAt, expectedUpdatedAt)
}
