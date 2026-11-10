import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * scripts/worktree-setup.sh against a throwaway origin + main clone: the one
 * way an agent worktree is made, and an audit that lists but never deletes.
 */
const script = join(import.meta.dirname, '../worktree-setup.sh')

let base = ''
let main = ''

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function setup(cwd: string, ...args: string[]): { code: number | null; out: string } {
  const r = spawnSync('bash', [script, ...args], { cwd, encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'wt-setup-')))
  const origin = join(base, 'origin.git')
  git(base, 'init', '--bare', '--initial-branch=main', origin)
  main = join(base, 'main')
  git(base, 'clone', '--quiet', origin, main)
  git(main, 'config', 'user.email', 'dev@example.com')
  git(main, 'config', 'user.name', 'Dev')
  writeFileSync(join(main, 'README'), 'x')
  git(main, 'add', 'README')
  git(main, 'commit', '--quiet', '-m', 'init')
  git(main, 'push', '--quiet', 'origin', 'main')
  mkdirSync(join(main, 'node_modules'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('worktree-setup', () => {
  it('adds a worktree from origin/main with the clone identity and a linked node_modules', () => {
    const r = setup(main, 'feat-x', 'feat-x')
    expect(r.code).toBe(0)
    const wt = join(main, '.claude/worktrees/feat-x')
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat-x')
    expect(git(wt, 'config', 'user.email')).toBe('dev@example.com')
    expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(wt, 'node_modules'))).toBe(join(main, 'node_modules'))
  })

  it('refuses an existing branch and an npm install', () => {
    expect(setup(main, 'a', 'main').code).toBe(1)
    expect(setup(main, '--install').code).toBe(2)
  })

  it('--prune lists a stray directory and an installed node_modules, deleting neither', () => {
    expect(setup(main, 'ok', 'ok').code).toBe(0)
    expect(setup(main, 'heavy', 'heavy').code).toBe(0)
    const heavy = join(main, '.claude/worktrees/heavy/node_modules')
    rmSync(heavy)
    mkdirSync(heavy)
    const stray = join(main, '.claude/worktrees/leftover')
    mkdirSync(stray)
    const r = setup(main, '--prune')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`stray (not a registered worktree, not deleted): ${stray}`)
    expect(r.out).toContain(`installed node_modules (not a link to main, not deleted): ${heavy}`)
    expect(r.out).not.toContain('worktrees/ok')
    expect(existsSync(stray)).toBe(true)
    expect(existsSync(heavy)).toBe(true)
  })
})
