/**
 * Unit tests for the canonical `formatLogLine` formatter. These are the
 * low-level contract tests; full end-to-end pipeline tests (broker hops,
 * agent forwarding, in-process direct write) live in
 * `packages/kernel/src/__tests__/moleculer/log-pipeline-e2e.spec.ts`.
 */
import { describe, it, expect } from 'vitest'
import { formatLogLine as rawFormatLogLine } from '../../logging/formatter.js'
import type { LogEntry } from '@camstack/types'

// Strip ANSI escapes so structural assertions are independent of the
// runner's TTY / FORCE_COLOR state (the colour-toggle test below exercises
// the raw output explicitly).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g
function formatLogLine(entry: LogEntry): string {
  return rawFormatLogLine(entry).replace(ANSI_RE, '')
}

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: new Date('2026-04-19T21:45:00.123Z'),
    level: 'info',
    message: 'test',
    ...overrides,
  }
}

describe('formatLogLine — NestJS layout', () => {
  it('produces NestJS-style line: [agent/addon] <pid> - <timestamp> LEVEL [device] (scope) message', () => {
    const line = formatLogLine(
      makeEntry({
        tags: { agentId: 'hub', addonId: 'provider-rtsp', deviceName: 'hall' },
        scope: 'createDevice',
        message: 'Registered streams',
      }),
    )
    // Brand bracket shows agent + addon joined by `/`.
    expect(line).toMatch(/^\[hub\/provider-rtsp\] /)
    // PID present.
    expect(line).toContain(String(process.pid))
    expect(line).toContain('  - ')
    // NestJS locale timestamp — `M/D/YYYY, H:MM:SS AM`.
    expect(line).toMatch(/\d{1,2}\/\d{1,2}\/\d{4},/)
    expect(line).toContain('INFO')
    // Device context bracket (separate from brand).
    expect(line).toContain('[hall]')
    // Scope rendered as `(scope)` before the message.
    expect(line).toContain('(createDevice)')
    expect(line).toContain('Registered streams')
  })

  it('always shows hub agent in the brand bracket', () => {
    const line = formatLogLine(
      makeEntry({
        tags: { agentId: 'hub', addonId: 'winston-logging' },
        message: 'Winston logging initialized',
      }),
    )
    expect(line).toMatch(/^\[hub\/winston-logging\] /)
    // No second bracket when there's no device tag.
    const openBrackets = (line.match(/\[/g) ?? []).length
    expect(openBrackets).toBe(1)
  })

  it('shows remote agent + addon in the brand bracket', () => {
    const line = formatLogLine(
      makeEntry({
        tags: { agentId: 'dev-agent-0', addonId: 'detection' },
      }),
    )
    expect(line).toMatch(/^\[dev-agent-0\/detection\] /)
    // No device context bracket.
    expect(line).not.toContain('[dev-agent-0]')
  })

  it('renders device as standalone bracket after level', () => {
    const line = formatLogLine(
      makeEntry({
        tags: { agentId: 'dev-agent-0', addonId: 'detection', deviceName: 'cortile' },
      }),
    )
    expect(line).toMatch(/^\[dev-agent-0\/detection\] /)
    expect(line).toContain('[cortile]')
  })

  it('renders `#<id>` for deviceId when deviceName is absent', () => {
    const line = formatLogLine(
      makeEntry({
        tags: { agentId: 'hub', addonId: 'stream-broker', deviceId: 42 },
      }),
    )
    expect(line).toContain('[#42]')
  })

  it('falls back to `system` when addonId tag is missing', () => {
    const line = formatLogLine(
      makeEntry({
        tags: { nodeId: 'hub' },
      }),
    )
    expect(line).toMatch(/^\[hub\/system\] /)
  })

  it('splits forked-worker nodeIds — slash in nodeId maps to agent=parent', () => {
    const line = formatLogLine(
      makeEntry({
        tags: { nodeId: 'hub/provider-rtsp', addonId: 'provider-rtsp' },
      }),
    )
    // nodeId literal never appears — agent is derived from first segment.
    expect(line).not.toMatch(/\bhub\/provider-rtsp\/provider-rtsp\b/)
    expect(line).toMatch(/^\[hub\/provider-rtsp\] /)
  })

  it('renders meta as `{k=v}` trailer after the message', () => {
    const line = formatLogLine(
      makeEntry({
        tags: { agentId: 'hub', addonId: 'stream-broker' },
        meta: { count: 3, src: 'main' },
      }),
    )
    expect(line).toMatch(/\{count=3 src=main\}$/)
  })

  it('quotes meta string values that contain spaces', () => {
    const line = formatLogLine(
      makeEntry({
        meta: { err: 'connection timed out' },
      }),
    )
    expect(line).toContain('err="connection timed out"')
  })

  it('serialises Error values by message only', () => {
    const line = formatLogLine(
      makeEntry({
        meta: { err: new Error('boom') },
      }),
    )
    expect(line).toContain('err="boom"')
  })

  it('falls back to `?/system` when no tags + no scope', () => {
    const line = formatLogLine(
      makeEntry({
        tags: undefined,
        message: 'bare message',
      }),
    )
    expect(line).toMatch(/^\[\?\/system\] /)
    expect(line).toContain('bare message')
    // No scope bracket when absent.
    expect(line).not.toMatch(/\(\w+\)/)
  })

  it('omits scope bracket when scope is empty string', () => {
    const line = formatLogLine(
      makeEntry({
        tags: { agentId: 'hub', addonId: 'core' },
        scope: '',
        message: 'no scope',
      }),
    )
    expect(line).not.toMatch(/ \(\) /)
  })

  it('colour toggle respects NO_COLOR / FORCE_COLOR / isTTY', () => {
    // Use the RAW formatter — the module-local `formatLogLine` shadowing
    // above strips ANSI, which would defeat this particular test.
    const line = rawFormatLogLine(makeEntry({ level: 'error', message: 'x' }))
    const hasAnsi = line.includes('\u001b[')
    const env = process.env
    const expected = env['NO_COLOR']
      ? false
      : env['FORCE_COLOR'] === '0'
        ? false
        : env['FORCE_COLOR']
          ? true
          : Boolean((process.stdout as { isTTY?: boolean }).isTTY)
    expect(hasAnsi).toBe(expected)
  })
})
