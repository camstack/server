import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { isHostExternal, HOST_EXTERNAL_SPECIFIERS } from '../host-externals.js'

describe('isHostExternal', () => {
  it('matches exact host-provided specifiers', () => {
    expect(isHostExternal('@camstack/system')).toBe(true)
    expect(isHostExternal('zod')).toBe(true)
  })

  it('matches subpath exports of host-provided specifiers', () => {
    expect(isHostExternal('@camstack/types/node')).toBe(true)
    expect(isHostExternal('@trpc/server/adapters/standalone')).toBe(true)
  })

  it('does not match unrelated or partial-prefix specifiers', () => {
    expect(isHostExternal('@camstack/addon-pipeline')).toBe(false)
    expect(isHostExternal('zod-extra')).toBe(false) // prefix but not a subpath
    expect(isHostExternal('node:fs')).toBe(false)
  })

  it('matches the addon-imported native deps as host-provided', () => {
    expect(isHostExternal('sharp')).toBe(true)
    expect(isHostExternal('sharp/lib/x')).toBe(true)
    expect(isHostExternal('node-av')).toBe(true)
    expect(isHostExternal('node-av/lib/something')).toBe(true)
    expect(isHostExternal('node-pty')).toBe(true)
    expect(isHostExternal('ssh2')).toBe(true)
  })

  it('does NOT treat better-sqlite3 as host-external (hub-only; addons use the storage cap)', () => {
    expect(isHostExternal('better-sqlite3')).toBe(false)
    expect(isHostExternal('better-sqlite3/lib/binding')).toBe(false)
  })

  it('exposes the canonical set', () => {
    expect(HOST_EXTERNAL_SPECIFIERS).toContain('@camstack/system')
    // Deleted with D763 — a native host-external nothing imports.
    expect(HOST_EXTERNAL_SPECIFIERS).not.toContain('@camstack/shm-ring')
    expect(HOST_EXTERNAL_SPECIFIERS).toContain('sharp')
    expect(HOST_EXTERNAL_SPECIFIERS).toContain('node-av')
    expect(HOST_EXTERNAL_SPECIFIERS).toContain('node-pty')
    expect(HOST_EXTERNAL_SPECIFIERS).toContain('ssh2')
    expect(HOST_EXTERNAL_SPECIFIERS).not.toContain('better-sqlite3')
  })
})

/**
 * Drift guard: the host-external list is mirrored in TWO other files that cannot
 * import this one (bootstrap isolation) — the zero-dep starter
 * (`node-root/src/starter-core.ts`) and the raw-ESM loader hook
 * (`moleculer/framework-resolver-hook.mjs`). If they drift, an addon's native
 * either fails to resolve (missing from a mirror) or leaks a per-addon install.
 * Compare by parsing each file's array literal from source text (no import).
 */
describe('HOST_EXTERNAL_SPECIFIERS mirrors stay in sync', () => {
  function parseMirror(relFromKernel: string): string[] {
    const abs = path.join(__dirname, relFromKernel)
    const text = readFileSync(abs, 'utf8')
    // Anchor on the ASSIGNMENT `= [ … ]`, not any `[` — a `readonly string[]`
    // type annotation contains a `[` that must not be mistaken for the literal.
    const m = /HOST_EXTERNAL_SPECIFIERS[^=]*=\s*\[([\s\S]*?)\]/.exec(text)
    const body = (m?.[1] ?? '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//')) // drop comment lines (may contain apostrophes)
      .join('\n')
    const found = body.match(/'([^']+)'/g) ?? []
    return found.map((q) => q.slice(1, -1)).sort()
  }

  it('the starter mirror equals the canonical set', () => {
    expect(parseMirror('../../../../node-root/src/starter-core.ts')).toEqual(
      [...HOST_EXTERNAL_SPECIFIERS].sort(),
    )
  })

  it('the loader-hook mirror equals the canonical set', () => {
    expect(parseMirror('../moleculer/framework-resolver-hook.mjs')).toEqual(
      [...HOST_EXTERNAL_SPECIFIERS].sort(),
    )
  })
})
