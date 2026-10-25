/**
 * What a new script starts as.
 *
 * Not an empty buffer: the contract a block must satisfy is
 * `export default (ctx) => disposer`, and the wrapper that enforces it
 * (`system/src/builtins/core-blocks/block-package.ts`) throws by NAME when the
 * default export is missing. An operator meeting that error on their first save
 * has been taught nothing — so the shape, and the disposer, are handed over
 * already written.
 *
 * The disposer is the part worth pre-writing. A block that owns a timer and
 * returns nothing keeps that timer until the node reboots: `setEnabled(false)`
 * stops the process, but a block edited-and-restarted in place leaks one
 * interval per save. Returning the cleanup makes that the default rather than
 * the thing an author remembers.
 *
 * Declaring devices: use `reconcileBlockDevices` / `exposeBlockDevices` from
 * `@camstack/types` so they hang off the shared Blocks integration (D97) —
 * never mint an integration from a block.
 *
 * The blank starter lives in `./examples` — homelab-specific scripts do not.
 */

import { SCRIPT_EXAMPLES } from './examples'

const blank = SCRIPT_EXAMPLES.find((e) => e.id === 'blank')

export const NEW_BLOCK_TEMPLATE: string =
  blank?.files['main.ts'] ??
  `import type { AddonContext } from '@camstack/types'

export default function block(ctx: AddonContext) {
  ctx.logger.info('hello from a core block')
  return () => undefined
}
`
