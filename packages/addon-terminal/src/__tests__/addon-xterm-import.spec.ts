/**
 * The live hub crash-looped the Terminal runner on boot:
 *   Init failed for "terminal": createXtermScreen is not defined
 *
 * Vite/esbuild will happily emit that ReferenceError — they do not typecheck.
 * The Admin UI then 412s on terminalSession.listProfiles because the provider
 * never registers. This test is the cheap tripwire that `npm test` actually
 * runs; tsc would have caught it too, but this package's ship path is vite.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('TerminalAddon screen factory binding', () => {
  it('imports createXtermScreen — a missing import crash-loops the runner', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'addon.ts'),
      'utf8',
    )
    expect(src).toMatch(
      /import\s*\{[^}]*\bcreateXtermScreen\b[^}]*\}\s*from\s*['"]\.\/xterm-screen\.js['"]/,
    )
  })
})
