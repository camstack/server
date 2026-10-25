import { describe, it, expect } from 'vitest'
import { renderAgentStatusPage, type AgentStatusData } from '../agent-status-page'

const makeStatusData = (overrides: Partial<AgentStatusData> = {}): AgentStatusData => ({
  agentId: 'agent-abc12345',
  agentName: 'test-agent',
  hubUrl: 'ws://localhost:4443/agent',
  connected: true,
  activeTaskCount: 3,
  taskTypes: ['pipeline.decode', 'pipeline.detect'],
  platform: 'darwin',
  arch: 'arm64',
  cpuCores: 8,
  memoryTotalMB: 16384,
  memoryFreeMB: 8192,
  uptime: 3661,
  ...overrides,
})

describe('renderAgentStatusPage', () => {
  it('renders valid HTML', () => {
    const html = renderAgentStatusPage(makeStatusData())
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('</html>')
  })

  it('includes agent name and ID', () => {
    const html = renderAgentStatusPage(makeStatusData())
    expect(html).toContain('test-agent')
    expect(html).toContain('agent-abc12345')
  })

  it('shows connected status with green dot', () => {
    const html = renderAgentStatusPage(makeStatusData({ connected: true }))
    expect(html).toContain('Connected')
    expect(html).toContain('#22c55e')
  })

  it('shows disconnected status with red dot', () => {
    const html = renderAgentStatusPage(makeStatusData({ connected: false }))
    expect(html).toContain('Disconnected')
    expect(html).toContain('#ef4444')
  })

  it('displays task types', () => {
    const html = renderAgentStatusPage(makeStatusData())
    expect(html).toContain('pipeline.decode')
    expect(html).toContain('pipeline.detect')
  })

  it('shows "no task handlers" when list is empty', () => {
    const html = renderAgentStatusPage(makeStatusData({ taskTypes: [] }))
    expect(html).toContain('No task handlers registered')
  })

  it('displays hardware info', () => {
    const html = renderAgentStatusPage(makeStatusData())
    expect(html).toContain('darwin')
    expect(html).toContain('arm64')
    expect(html).toContain('8')
  })

  it('calculates memory usage', () => {
    const html = renderAgentStatusPage(makeStatusData({ memoryTotalMB: 16384, memoryFreeMB: 4096 }))
    // 12288 / 16384 = 75%
    expect(html).toContain('12288')
    expect(html).toContain('75%')
  })

  it('escapes HTML in user-provided strings', () => {
    const html = renderAgentStatusPage(
      makeStatusData({ agentName: '<script>alert("xss")</script>' }),
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('auto-refreshes every 5 seconds', () => {
    const html = renderAgentStatusPage(makeStatusData())
    expect(html).toContain('http-equiv="refresh" content="5"')
  })
})
