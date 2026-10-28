/**
 * An agent keeps its own `@camstack/server` closure current (2026-10-28): unpaired it follows
 * npm `latest` (there is no hub), paired it follows the HUB's running version (never npm, so
 * there is no hub/agent skew). Never a downgrade; a failed read changes nothing and says why.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  agentSelfUpdateEnabled,
  decideAgentSelfUpdate,
  runAgentSelfUpdate,
  type AgentSelfUpdatePorts,
} from '../agent-self-update.js'

describe('decideAgentSelfUpdate', () => {
  it('unpaired targets the npm latest', () => {
    const d = decideAgentSelfUpdate({
      paired: false,
      running: '1.2.632',
      npmLatest: { ok: true, version: '1.2.700' },
      hubVersion: '1.2.650',
      pendingVersion: null,
    })
    expect(d).toEqual({
      action: 'stage',
      version: '1.2.700',
      source: 'npm-latest',
    })
  })

  it('paired targets the hub version, never npm latest', () => {
    const d = decideAgentSelfUpdate({
      paired: true,
      running: '1.2.632',
      npmLatest: { ok: true, version: '1.2.700' },
      hubVersion: '1.2.650',
      pendingVersion: null,
    })
    expect(d).toEqual({ action: 'stage', version: '1.2.650', source: 'hub' })
  })

  it('skips when the target equals the running version', () => {
    const d = decideAgentSelfUpdate({
      paired: true,
      running: '1.2.650',
      npmLatest: { ok: true, version: '1.2.700' },
      hubVersion: '1.2.650',
      pendingVersion: null,
    })
    expect(d.action).toBe('skip')
  })

  it('never downgrades to an older target', () => {
    const d = decideAgentSelfUpdate({
      paired: true,
      running: '1.2.700',
      npmLatest: { ok: true, version: '1.2.700' },
      hubVersion: '1.2.650',
      pendingVersion: null,
    })
    expect(d.action).toBe('skip')
    expect(d.action === 'skip' && d.reason).toMatch(/older|downgrade/)
  })

  it('a failed npm read changes nothing and names the reason', () => {
    const d = decideAgentSelfUpdate({
      paired: false,
      running: '1.2.632',
      npmLatest: { ok: false, reason: 'ENOTFOUND registry' },
      hubVersion: null,
      pendingVersion: null,
    })
    expect(d).toMatchObject({ action: 'skip', failedRead: true })
    expect(d.action === 'skip' && d.reason).toContain('ENOTFOUND registry')
  })

  it('a paired agent that does not know the hub version does nothing and says so', () => {
    const d = decideAgentSelfUpdate({
      paired: true,
      running: '1.2.632',
      npmLatest: { ok: true, version: '1.2.700' },
      hubVersion: null,
      pendingVersion: null,
    })
    expect(d).toMatchObject({ action: 'skip', failedRead: true })
  })

  it('skips a version that is already staged', () => {
    const d = decideAgentSelfUpdate({
      paired: false,
      running: '1.2.632',
      npmLatest: { ok: true, version: '1.2.700' },
      hubVersion: null,
      pendingVersion: '1.2.700',
    })
    expect(d.action).toBe('skip')
  })

  it('an unknown running version does nothing', () => {
    const d = decideAgentSelfUpdate({
      paired: false,
      running: null,
      npmLatest: { ok: true, version: '1.2.700' },
      hubVersion: null,
      pendingVersion: null,
    })
    expect(d).toMatchObject({ action: 'skip', failedRead: true })
  })
})

describe('agentSelfUpdateEnabled', () => {
  it('is on unless the operator turned it off', () => {
    expect(agentSelfUpdateEnabled({})).toBe(true)
    expect(agentSelfUpdateEnabled({ CAMSTACK_AGENT_SELF_UPDATE: 'on' })).toBe(true)
    expect(agentSelfUpdateEnabled({ CAMSTACK_AGENT_SELF_UPDATE: 'off' })).toBe(false)
    expect(agentSelfUpdateEnabled({ CAMSTACK_AGENT_SELF_UPDATE: '0' })).toBe(false)
  })
})

function harness(over: Partial<AgentSelfUpdatePorts> = {}) {
  const lines: string[] = []
  const log = (m: string): void => void lines.push(m)
  const apply = vi.fn(async (_v: string) => ({
    accepted: true,
    outcome: 'staged',
    message: 'ok',
  }))
  const ports: AgentSelfUpdatePorts = {
    enabled: () => true,
    isPaired: () => false,
    getHubServerVersion: () => null,
    runningVersion: () => '1.2.632',
    checkLatest: async () => ({
      latestVersion: '1.2.700',
      error: null,
      pendingVersion: null,
    }),
    apply,
    log: { info: log, warn: log },
    ...over,
  }
  return { ports, lines, apply }
}

describe('runAgentSelfUpdate', () => {
  it('stages the npm latest for an unpaired agent and logs both versions', async () => {
    const h = harness()
    await runAgentSelfUpdate(h.ports)
    expect(h.apply).toHaveBeenCalledWith('1.2.700')
    expect(h.lines.join('\n')).toMatch(/1\.2\.632.*1\.2\.700|1\.2\.700.*1\.2\.632/)
  })

  it('stages the hub version for a paired agent', async () => {
    const h = harness({
      isPaired: () => true,
      getHubServerVersion: () => '1.2.650',
    })
    await runAgentSelfUpdate(h.ports)
    expect(h.apply).toHaveBeenCalledWith('1.2.650')
  })

  it('does nothing and logs the reason when the registry read failed', async () => {
    const h = harness({
      checkLatest: async () => ({
        latestVersion: null,
        error: 'offline',
        pendingVersion: null,
      }),
    })
    await runAgentSelfUpdate(h.ports)
    expect(h.apply).not.toHaveBeenCalled()
    expect(h.lines.join('\n')).toContain('offline')
  })

  it('does nothing when switched off', async () => {
    const h = harness({ enabled: () => false })
    await runAgentSelfUpdate(h.ports)
    expect(h.apply).not.toHaveBeenCalled()
    expect(h.lines.join('\n')).toMatch(/off|disabled/)
  })

  it('logs a refused or failed apply', async () => {
    const h = harness({
      apply: async () => ({
        accepted: false,
        outcome: 'refused',
        message: 'workspace',
      }),
    })
    await runAgentSelfUpdate(h.ports)
    expect(h.lines.join('\n')).toContain('workspace')
  })

  it('a throwing port is logged, not thrown', async () => {
    const h = harness({
      checkLatest: async () => {
        throw new Error('boom')
      },
    })
    await expect(runAgentSelfUpdate(h.ports)).resolves.toBeUndefined()
    expect(h.lines.join('\n')).toContain('boom')
  })
})
