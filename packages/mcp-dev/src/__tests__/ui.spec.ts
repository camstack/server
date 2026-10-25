import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { requireWorkspaceRoot } from '@camstack/develop'
import { resolveInsideRoot, runUiCli } from '../ui/run.js'

describe('ui tools over scripts/ui/cli.ts', () => {
  const root = requireWorkspaceRoot()

  it('finds a component for a need', () => {
    const r = runUiCli(root, 'find', ['confirm dialog'])
    expect(r.exitCode).toBe(0)
    expect(r.output.length).toBeGreaterThan(0)
  })

  it('lists admin tokens', () => {
    const r = runUiCli(root, 'tokens', ['admin'])
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('foreground')
  })

  it('flags palette classes and raw hex in a file inside the workspace', () => {
    const dir = fs.mkdtempSync(path.join(root, 'packages', 'mcp-dev', 'src', '.tmp-ui-'))
    try {
      const file = path.join(dir, 'Bad.tsx')
      fs.writeFileSync(
        file,
        `export function Bad() {\n  return <div className="bg-zinc-900" style={{ color: '#ff0000' }} />\n}\n`,
        'utf8',
      )
      const rel = resolveInsideRoot(root, file)
      expect(rel).not.toBeNull()
      const r = runUiCli(root, 'check', [rel ?? '', '--warn'])
      expect(r.output).toMatch(/finding/)
      expect(r.output).not.toMatch(/, 0 finding/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a path outside the workspace', () => {
    expect(resolveInsideRoot(root, '/etc/passwd')).toBeNull()
    expect(resolveInsideRoot(root, '../outside.tsx')).toBeNull()
  })
})
