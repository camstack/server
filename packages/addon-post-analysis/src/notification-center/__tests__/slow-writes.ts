/** Test helper (D698): a records world whose writes land late. */
import type { InMemoryRecords } from '@camstack/types'
import { withNcFaults } from './support/nc-test-deps.js'

/**
 * The same world, but every WRITE is held until `release()` — a write that
 * lands AFTER the load's read, which nothing on the transport rules out.
 */
export function slowWrites(world: InMemoryRecords): {
  readonly world: InMemoryRecords
  readonly release: () => void
} {
  let open: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  return {
    world: withNcFaults(world, { aroundWrite: () => gate }),
    release: () => open(),
  }
}
