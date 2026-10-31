import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { rolldown } from 'rolldown'
import { describe, expect, it } from 'vitest'
import { HOOK_ALIAS_HELPER, emitHookEntry } from '../lib/system-hooks-emit'

/**
 * A page addon bundles ui-library's source. If an UNUSED generated hook
 * survives bundling, every new hook changes the built output of every addon
 * page, and the publish output check reports "dist differs" for all of them
 * (planning #332). The emitted text must therefore bundle away when unused.
 */
async function bundle(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'system-hooks-'))
  writeFileSync(
    path.join(dir, 'trpc.js'),
    `export const trpc = new Proxy({}, { get: (_t, cap) => new Proxy({}, { get: (_u, m) => ({ useQuery: () => String(cap) + '.' + String(m) }) }) })\n`,
  )
  const hooks = [
    emitHookEntry('useUsedHook', 'trpc.cap.used.useQuery'),
    emitHookEntry('useNeverImported', 'trpc.cap.neverImported.useQuery'),
  ].join('\n')
  writeFileSync(
    path.join(dir, 'hooks.ts'),
    `import { trpc } from './trpc.js'\n${HOOK_ALIAS_HELPER}\n${hooks}\n`,
  )
  writeFileSync(
    path.join(dir, 'entry.js'),
    `import { useUsedHook } from './hooks.ts'\nconsole.log(useUsedHook())\n`,
  )
  const build = await rolldown({ input: path.join(dir, 'entry.js'), logLevel: 'silent' })
  const { output } = await build.generate({ format: 'esm' })
  return output.map((o) => (o.type === 'chunk' ? o.code : '')).join('\n')
}

describe('generated system hooks tree-shake', () => {
  it('keeps the hook a page uses and drops the one nothing imports', async () => {
    const code = await bundle()
    expect(code).toContain('used')
    expect(code).not.toContain('neverImported')
  })
})
