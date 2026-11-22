import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveMotionWasmPath } from '../wasm-motion-path.js'

/**
 * The bundler decides where the detector's code lands: `dist/motion-wasm/`
 * when one entry owns it, a shared chunk directly in `dist/` once a second
 * entry imports it (the node benchmark did, and every `detection` runner
 * died at boot on `<addons>/@camstack/wasm/motion.wasm`).
 */
describe('resolveMotionWasmPath', () => {
  let root = ''
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  function packageWithWasm(): string {
    root = mkdtempSync(join(tmpdir(), 'motion-wasm-'))
    const pkg = join(root, 'addon-pipeline')
    mkdirSync(join(pkg, 'wasm'), { recursive: true })
    mkdirSync(join(pkg, 'dist', 'motion-wasm'), { recursive: true })
    writeFileSync(join(pkg, 'wasm', 'motion.wasm'), 'x')
    return pkg
  }

  it('finds the wasm from an entry directory (dist/motion-wasm)', () => {
    const pkg = packageWithWasm()
    expect(resolveMotionWasmPath(join(pkg, 'dist', 'motion-wasm'))).toBe(
      join(pkg, 'wasm', 'motion.wasm'),
    )
  })

  it('finds the wasm from a shared chunk directly in dist/', () => {
    const pkg = packageWithWasm()
    expect(resolveMotionWasmPath(join(pkg, 'dist'))).toBe(join(pkg, 'wasm', 'motion.wasm'))
  })

  it('names every place it looked when the file is missing', () => {
    root = mkdtempSync(join(tmpdir(), 'motion-wasm-'))
    const dist = join(root, 'pkg', 'dist')
    mkdirSync(dist, { recursive: true })
    expect(() => resolveMotionWasmPath(dist)).toThrow(/motion\.wasm not found; looked in/)
  })
})
