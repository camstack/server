import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HubCall } from '../../hub/hub-call.js'
import { applyPlan, planTemplates } from '../add-source-select-row.js'

const layout = (role: string) => ({
  columns: 2,
  rows: 1,
  buttons: [{ id: 'a', row: 0, col: 0, rowSpan: 1, colSpan: 1, role }],
})
const rows = ['t1', 't2', 't3'].map((id) => ({ id, name: id, payload: layout('power') }))

function fakeHub(answer: (id: string) => unknown, events: string[]): HubCall {
  return {
    query: async () => rows,
    mutate: async (_route, input) => {
      const id = (input as { id: string }).id
      events.push(`update:${id}`)
      return answer(id)
    },
  }
}

describe('applyPlan', () => {
  it('writes the backup of the originals before the first update', async () => {
    const events: string[] = []
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'ssr-')), 'backup.json')
    const hub = fakeHub(() => ({ status: 'saved' }), events)
    const planned = await planTemplates(hub)
    const result = await applyPlan(hub, planned, file, (line) => {
      if (line.startsWith('backup')) events.push('backup')
    })
    expect(events).toEqual(['backup', 'update:t1', 'update:t2', 'update:t3'])
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toHaveLength(3)
    expect(result).toEqual({ updated: 3, failed: 0 })
  })

  it('counts a refused or throwing update as a failure and still updates the rest', async () => {
    const events: string[] = []
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'ssr-')), 'backup.json')
    const hub: HubCall = {
      query: async () => rows,
      mutate: async (_route, input) => {
        const id = (input as { id: string }).id
        events.push(id)
        if (id === 't1') return { status: 'refused', reason: 'invalid-payload' }
        if (id === 't2') throw new Error('boom')
        return { status: 'saved' }
      },
    }
    const lines: string[] = []
    const result = await applyPlan(hub, await planTemplates(hub), file, (l) => lines.push(l))
    expect(events).toEqual(['t1', 't2', 't3'])
    expect(result).toEqual({ updated: 1, failed: 2 })
    expect(lines.filter((l) => l.startsWith('FAILED'))).toHaveLength(2)
  })

  it('writes no backup when nothing needs changing', async () => {
    const hub: HubCall = {
      query: async () => [{ id: 't', name: 't', payload: layout('source_select') }],
      mutate: async () => ({ status: 'saved' }),
    }
    const result = await applyPlan(hub, await planTemplates(hub), '/nonexistent/dir/x.json')
    expect(result).toEqual({ updated: 0, failed: 0 })
  })
})
