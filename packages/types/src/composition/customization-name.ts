/**
 * The stored name of the implicit block that customizes an existing device
 * (D663). The ONLY composition file that imports `node:crypto`, which is why it
 * is exported from `@camstack/types/node` and never from the browser barrel.
 */
import { createHash } from 'node:crypto'
import {
  CUSTOMIZATION_BLOCK_NAME_PREFIX,
  type CompositionSourceRef,
  compositionSourceKey,
} from './composition.js'

/** `CompositionBlockInputSchema.name` is `max(120)` (`core-blocks.cap.ts`). */
const MAX_BLOCK_NAME_LENGTH = 120
const HASH_HEX_LENGTH = 32

/**
 * Derived by the SERVER on save, never sent by the client; never shown as the
 * device's name. Unique per target: the plain ref when it fits, else a hash.
 */
export function customizationBlockName(ref: CompositionSourceRef): string {
  const key = compositionSourceKey(ref)
  const plain = `${CUSTOMIZATION_BLOCK_NAME_PREFIX}${key}`
  if (plain.length <= MAX_BLOCK_NAME_LENGTH) return plain
  const digest = createHash('sha256').update(key).digest('hex')
  return `${CUSTOMIZATION_BLOCK_NAME_PREFIX}#${digest.slice(0, HASH_HEX_LENGTH)}`
}
