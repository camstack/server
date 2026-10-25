import { describe, expect, it } from 'vitest'
import type { ProcessRunner } from '../models/eval.js'
import { DeniedCommandError, releaseRunner, whyDenied } from '../release/commands.js'
import { classifyPath, releasePlan } from '../release/plan.js'
import { releaseStatus } from '../release/status.js'

describe('release commands — an allow-list of reads', () => {
  const denied: [string, string[]][] = [
    ['npm', ['publish']],
    ['npm', ['publish', '--access', 'public']],
    ['npm', ['deprecate', '@camstack/x', 'msg']],
    ['npm', ['dist-tag', 'add', '@camstack/x@1.0.0', 'latest']],
    ['npm', ['run', 'publish']],
    ['gh', ['workflow', 'run', 'Publish Packages', '--ref', 'main']],
    ['gh', ['workflow', 'run', 'Checks']],
    ['gh', ['run', 'rerun', '123']],
    ['gh', ['run', 'cancel', '123']],
    ['gh', ['release', 'create', 'v1']],
    ['gh', ['api', '-X', 'POST', 'repos/x/y/dispatches']],
    ['git', ['push', 'origin', 'main']],
    ['git', ['tag', 'v1.0.0']],
    ['git', ['commit', '-m', 'x']],
    ['git', ['-c', 'core.pager=sh', 'log']],
    ['git', ['diff', '--output=/tmp/x']],
    ['docker', ['ps']],
    ['ssh', ['host']],
    ['bash', ['-c', 'npm publish']],
  ]
  it.each(denied)('refuses %s %j', (command, args) => {
    expect(whyDenied(command, args)).not.toBeNull()
  })

  const allowed: [string, string[]][] = [
    ['git', ['rev-parse', 'HEAD']],
    ['git', ['rev-list', '--left-right', '--count', 'origin/main...HEAD']],
    ['git', ['diff', '--name-only', 'a', 'b']],
    ['gh', ['run', 'list', '--workflow', 'ci.yml', '--limit', '3']],
    ['gh', ['run', 'view', '123']],
    ['npm', ['view', '@camstack/server', 'version']],
  ]
  it.each(allowed)('allows %s %j', (command, args) => {
    expect(whyDenied(command, args)).toBeNull()
  })

  it('the runner never reaches the base runner for a denied command', async () => {
    const spawned: string[] = []
    const base: ProcessRunner = async (command, args) => {
      spawned.push(`${command} ${args.join(' ')}`)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const run = releaseRunner(base)
    await expect(run('npm', ['publish'], '/w')).rejects.toBeInstanceOf(DeniedCommandError)
    await expect(run('gh', ['workflow', 'run', 'Publish Packages'], '/w')).rejects.toThrow(
      /refused/,
    )
    expect(spawned).toEqual([])
    await run('git', ['rev-parse', 'HEAD'], '/w')
    expect(spawned).toEqual(['git rev-parse HEAD'])
  })
})

describe('release_plan — classification and the train', () => {
  it('classifies paths', () => {
    expect(classifyPath('packages/types/src/capabilities/motion.cap.ts').kind).toBe('capability')
    expect(classifyPath('packages/system/src/x.ts').kind).toBe('framework')
    expect(classifyPath('server/backend/src/main.ts').kind).toBe('framework')
    expect(classifyPath('packages/addon-reolink/src/a.ts')).toMatchObject({
      kind: 'addon',
      addonDir: 'packages/addon-reolink',
    })
    expect(classifyPath('packages/addon-pipeline/src/a.ts').kind).toBe('bootstrap-addon')
    expect(classifyPath('packages/node-root/src/start.ts').kind).toBe('image')
    expect(classifyPath('camstack/src/app/x.ts').kind).toBe('viewer')
    expect(classifyPath('docs/architecture/x.md').kind).toBe('docs-or-scripts')
  })

  it('a docs-only change ships nothing', () => {
    const plan = releasePlan(['docs/x.md', 'scripts/check-y.ts'])
    expect(plan.nothingToShip).toBe(true)
    expect(plan.steps).toEqual([])
    expect(plan.executesNothing).toBe(true)
  })

  it('a capability change forces system+server, then applyServerUpdate, then deploys, then verify', () => {
    const plan = releasePlan([
      'packages/types/src/capabilities/motion.cap.ts',
      'packages/addon-reolink/src/a.ts',
    ])
    const titles = plan.steps.map((s) => s.title)
    expect(titles[0]).toBe('Preflight')
    expect(titles.indexOf('Publish through CI')).toBeLessThan(
      titles.findIndex((t) => t.startsWith('applyServerUpdate')),
    )
    expect(titles.findIndex((t) => t.startsWith('applyServerUpdate'))).toBeLessThan(
      titles.findIndex((t) => t.startsWith('Deploy')),
    )
    expect(titles.at(-1)).toBe('Verify it is LIVE')
    const all = plan.steps.flatMap((s) => s.commands).join('\n')
    expect(all).toContain('force_packages=@camstack/system,@camstack/server')
    expect(all).toContain('include_dependents=false')
    expect(all).toContain('camstack deploy packages/addon-reolink')
    expect(all).not.toMatch(/--all|scope=all/)
  })

  it('a viewer change carries the OTA, the bundle and the pin together', () => {
    const plan = releasePlan(['camstack/src/screens/x.tsx'])
    const cmds = plan.steps.flatMap((s) => s.commands).join('\n')
    expect(cmds).toMatch(/whats-new/)
    expect(cmds).toMatch(/update:patch/)
    expect(cmds).toMatch(/build:orchestrator/)
    expect(cmds).toMatch(/submodule pin/)
  })

  it('carries the traps, including the registry-lag and never-dispatch-Checks ones', () => {
    const plan = releasePlan(['packages/system/src/x.ts'])
    expect(plan.traps.join('\n')).toMatch(/Registry lag/)
    expect(plan.traps.join('\n')).toMatch(/Checks/)
  })
})

describe('release_status — reads only', () => {
  it('only ever runs allow-listed reads, and reports a failed read as failed', async () => {
    const seen: string[] = []
    const base: ProcessRunner = async (command, args) => {
      seen.push(`${command} ${args.join(' ')}`)
      if (command === 'git' && args[0] === 'rev-parse') {
        return { exitCode: 0, stdout: args[1] === 'HEAD' ? 'aaa\n' : 'bbb\n', stderr: '' }
      }
      if (command === 'git' && args[0] === 'rev-list')
        return { exitCode: 0, stdout: '0\t2\n', stderr: '' }
      if (command === 'git' && args[0] === 'describe')
        return { exitCode: 0, stdout: 'publish-1\n', stderr: '' }
      if (command === 'git' && args[0] === 'diff')
        return { exitCode: 0, stdout: 'packages/types/a.ts\n', stderr: '' }
      if (command === 'gh') return { exitCode: 1, stdout: '', stderr: 'gh: not logged in' }
      if (command === 'npm') return { exitCode: 0, stdout: '9.9.9\n', stderr: '' }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' }
    }
    const status = await releaseStatus('/definitely/not/a/workspace', {
      run: releaseRunner(base),
      hubVersions: async () => {
        throw new Error('no hub credential')
      },
    })
    expect(status.git).toMatchObject({
      ok: true,
      value: { head: 'aaa', originMain: 'bbb', ahead: 2, behind: 0, lastPublishTag: 'publish-1' },
    })
    expect(status.ci.ok).toBe(false)
    expect(status.ci.error).toMatch(/not logged in/)
    expect(status.hub).toEqual({ ok: false, error: 'no hub credential' })
    expect(status.npm.map((n) => n.name)).toContain('@camstack/server')
    expect(status.npm[0]?.registry).toEqual({ ok: true, value: '9.9.9' })
    // every process it spawned passed the allow-list
    for (const line of seen) {
      const [command, ...args] = line.split(' ')
      expect(whyDenied(command ?? '', args), line).toBeNull()
    }
    expect(seen.some((l) => /^(npm publish|gh workflow|git push|git tag )/.test(l))).toBe(false)
  })
})
