/**
 * An agent with no chosen name is called `<short hostname>-<arch>` - never its node id.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentName, loadAgentConfig } from '../agent-config.js'

describe('defaultAgentName', () => {
  it('is the short host name followed by the architecture', () => {
    expect(defaultAgentName('Gianlucas-Mac-mini.local', 'arm64')).toBe('Gianlucas-Mac-mini-arm64')
    expect(defaultAgentName('box.localdomain', 'x64')).toBe('box-x64')
    expect(defaultAgentName('nas.home.example.test', 'x64')).toBe('nas-x64')
    expect(defaultAgentName('plain', 'x64')).toBe('plain-x64')
  })

  it('still names an agent whose host name is empty', () => {
    expect(defaultAgentName('', 'arm64')).toBe('agent-arm64')
  })
})

describe('the name a fresh agent reports', () => {
  const dirs: string[] = []
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  function freshDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-name-'))
    dirs.push(dir)
    return dir
  }

  it('is host-arch, not the generated node id', () => {
    vi.stubEnv('CAMSTACK_AGENT_NAME', '')
    vi.stubEnv('CAMSTACK_NODE_ID', '')
    const config = loadAgentConfig('agent.json', freshDir())
    expect(config.name).toBe(defaultAgentName(os.hostname(), os.arch()))
    expect(config.name).not.toBe(config.nodeId)
  })

  it('is not the node id seed either', () => {
    vi.stubEnv('CAMSTACK_AGENT_NAME', '')
    vi.stubEnv('CAMSTACK_NODE_ID', 'dev-agent-0')
    const config = loadAgentConfig('agent.json', freshDir())
    expect(config.nodeId).toBe('dev-agent-0')
    expect(config.name).toBe(defaultAgentName(os.hostname(), os.arch()))
  })

  it('takes CAMSTACK_AGENT_NAME, and a persisted name wins over both', () => {
    vi.stubEnv('CAMSTACK_AGENT_NAME', 'gpu-box')
    const dir = freshDir()
    expect(loadAgentConfig('agent.json', dir).name).toBe('gpu-box')
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ name: 'kitchen-mac' }))
    expect(loadAgentConfig('agent.json', dir).name).toBe('kitchen-mac')
  })
})
