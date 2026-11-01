import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkNodeVersion, INSTALLER_COMMAND, nodeMajorOf } from '../node-guard.js'

describe('node guard', () => {
  it('refuses a Node older than 24 with the installer line and exit 78', () => {
    const verdict = checkNodeVersion('20.11.1')
    expect(verdict).toMatchObject({ ok: false, exitCode: 78 })
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.message).toContain(INSTALLER_COMMAND)
    expect(verdict.message).toContain('Node 24')
    expect(verdict.message.split('\n')).toHaveLength(1)
  })

  it('accepts 24 and newer; an unreadable version counts as too old', () => {
    expect(checkNodeVersion('24.0.0').ok).toBe(true)
    expect(checkNodeVersion('25.2.1').ok).toBe(true)
    expect(checkNodeVersion('garbage').ok).toBe(false)
    expect(nodeMajorOf('24.1.0')).toBe(24)
  })

  it('the entry imports only the guard: the real CLI loads after the check', () => {
    const source = readFileSync(fileURLToPath(new URL('../cli.ts', import.meta.url)), 'utf8')
    const staticImports = source.split('\n').filter((l) => /^import\s/.test(l))
    expect(staticImports).toEqual(["import { checkNodeVersion } from './node-guard.js'"])
  })
})
