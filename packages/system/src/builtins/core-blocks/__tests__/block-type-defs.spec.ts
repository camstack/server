/**
 * getTypeDefs resolution — pins the failure that served the image-seed
 * `@camstack/types` (no `optionsFrom`) while the live data-root closure had
 * the current contract. `createRequire(import.meta.url)` must win over
 * `process.cwd()`.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BLOCK_NODE_AMBIENT, loadBlockTypeDefs, resolveTypesDist } from '../block-type-defs.js'

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
}

describe('resolveTypesDist', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('resolves @camstack/types next to this module, not via process.cwd()', async () => {
    // A cwd that looks like the hub image seed: has a types package, but it is
    // NOT the one this workspace loaded. If resolution prefers cwd, we get
    // this fake — the production bug.
    const fakeCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'block-typedefs-cwd-'))
    const fakeTypes = path.join(fakeCwd, 'node_modules', '@camstack', 'types', 'dist')
    await fs.mkdir(fakeTypes, { recursive: true })
    await fs.writeFile(path.join(fakeTypes, 'index.d.ts'), 'export type FromCwd = true\n')

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd)
    try {
      const resolved = await resolveTypesDist()
      expect(resolved).not.toBeNull()
      expect(resolved).not.toBe(fakeTypes)
      const index = await fs.readFile(path.join(resolved!, 'index.d.ts'), 'utf-8')
      expect(index).not.toContain('FromCwd')
      // The real workspace types carry optionsFrom (the field the editor was missing).
      const configUi = path.join(resolved!, 'interfaces', 'config-ui.d.ts')
      const configText = await fs.readFile(configUi, 'utf-8')
      expect(configText).toContain('optionsFrom')
    } finally {
      cwdSpy.mockRestore()
      await fs.rm(fakeCwd, { recursive: true, force: true })
    }
  })
})

describe('loadBlockTypeDefs', () => {
  it('serves types + zod + the Node ambient under the virtual paths Monaco resolves', {
    timeout: 30_000,
  }, async () => {
    const libs = await loadBlockTypeDefs(silentLogger as never)
    const paths = libs.map((l) => l.filePath)

    expect(paths.some((p) => p.startsWith('file:///node_modules/@camstack/types/'))).toBe(true)
    expect(paths.some((p) => p.includes('config-ui.d.ts'))).toBe(true)
    expect(
      libs.some((l) => l.filePath.includes('config-ui.d.ts') && l.content.includes('optionsFrom')),
    ).toBe(true)

    expect(paths.some((p) => p.startsWith('file:///node_modules/zod/'))).toBe(true)
    expect(paths).toContain('file:///node_modules/@types/node/index.d.ts')
    expect(
      libs.find((l) => l.filePath === 'file:///node_modules/@types/node/index.d.ts')?.content,
    ).toBe(BLOCK_NODE_AMBIENT)
  })
})
