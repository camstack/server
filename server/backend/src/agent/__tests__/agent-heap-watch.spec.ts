/**
 * The agent root gets hub-main's heartbeat + reclaim. Before this, `agent/main.ts`
 * started none: an agent root of 0.8–1.4 GB emitted no `[mem]` line and never
 * gave a page back.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_MAIN_HEAP_WATCH_LABEL, type HeapReclaimer, startHeapWatch } from '@camstack/system'
import { describe, expect, it, vi } from 'vitest'
import { startAgentHeapWatch } from '../agent-heap-watch.js'

describe('startAgentHeapWatch', () => {
  it('starts the heartbeat as agent-main with the reclaimer and the logger as sink', () => {
    const reclaimer: HeapReclaimer = () => {}
    const start = vi.fn<typeof startHeapWatch>(() => () => {})
    const info = vi.fn()
    const warn = vi.fn()

    startAgentHeapWatch({ info, warn }, { start, createReclaimer: () => reclaimer })

    expect(start).toHaveBeenCalledTimes(1)
    const [label, sink, , reclaimOptions] = start.mock.calls[0] ?? []
    expect(label).toBe(AGENT_MAIN_HEAP_WATCH_LABEL)
    expect(label).toBe('agent-main')
    expect(reclaimOptions?.reclaim).toBe(reclaimer)
    sink?.info('[mem] x')
    sink?.warn('[mem] y')
    expect(info).toHaveBeenCalledWith('[mem] x')
    expect(warn).toHaveBeenCalledWith('[mem] y')
  })

  it('runs report-only when V8 declines to hand out a reclaimer', () => {
    const start = vi.fn<typeof startHeapWatch>(() => () => {})
    startAgentHeapWatch(
      { info: () => {}, warn: () => {} },
      { start, createReclaimer: () => undefined },
    )
    expect(start.mock.calls[0]?.[3]).toBeUndefined()
  })

  it('is called from startAgent, before the config is loaded', () => {
    const source = readFileSync(join(__dirname, '../main.ts'), 'utf8')
    const body = source.slice(source.indexOf('async function startAgent('))
    const watch = body.indexOf('startAgentHeapWatch(')
    expect(watch).toBeGreaterThan(-1)
    expect(watch).toBeLessThan(body.indexOf('loadAgentConfig(configPath)'))
  })
})
