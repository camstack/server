/**
 * Where `motion.wasm` lives, found from the directory of the code asking.
 *
 * The file ships at the package's `wasm/motion.wasm`, one level above
 * `dist/`. The bundler decides how deep the detector's code sits under
 * `dist/`: `dist/motion-wasm/` while one entry owns it, `dist/` itself once
 * a second entry imports it and it becomes a shared chunk. A fixed relative
 * path broke every `detection` runner the day the node benchmark imported
 * the detector, so the path is searched upward instead.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** How many parent directories are searched above the caller's own. */
const MAX_LEVELS_UP = 3

export function resolveMotionWasmPath(fromDir: string): string {
  const tried: string[] = []
  let dir = fromDir
  for (let level = 0; level <= MAX_LEVELS_UP; level++) {
    const candidate = join(dir, 'wasm', 'motion.wasm')
    if (existsSync(candidate)) return candidate
    tried.push(candidate)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`motion.wasm not found; looked in ${tried.join(', ')}`)
}
