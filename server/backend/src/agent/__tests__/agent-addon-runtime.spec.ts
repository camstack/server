/**
 * The agent UI's single addon list (D841): addon → runner comes from the
 * process service's own `addonIds`, never from a grouping rule of ours.
 */
import { describe, expect, it } from 'vitest'
import {
  addonsFromStatus,
  joinAddonRuntime,
  processesFromList,
  type RuntimeProcessInput,
} from '../agent-addon-runtime.js'

const runner = (name: string, addonIds: string[], pid = 100): RuntimeProcessInput => ({
  name,
  pid,
  state: 'running',
  groupId: name,
  addonIds,
  cpuPercent: 1.5,
  memoryRss: 1024,
  uptimeSeconds: 60,
})

describe('joinAddonRuntime', () => {
  const addons = [
    { id: 'decoder', status: 'running', version: '1.0.0', packageName: '@camstack/addon-d' },
    { id: 'ml-a', status: 'running', version: '2.0.0', packageName: '@camstack/addon-ml' },
    { id: 'ml-b', status: 'running', version: '2.0.0', packageName: '@camstack/addon-ml' },
    { id: 'in-process', status: 'running' },
  ]

  it('gives each addon the runner that lists it, and shows a shared runner on every member', () => {
    const rows = joinAddonRuntime(addons, [
      runner('decoder', ['decoder'], 11),
      runner('ml', ['ml-a', 'ml-b'], 22),
    ])
    const byId = new Map(rows.map((r) => [r.key, r]))
    expect(byId.get('decoder')?.runner).toMatchObject({ pid: 11, groupId: 'decoder' })
    expect(byId.get('ml-a')?.runner).toMatchObject({ pid: 22, groupId: 'ml' })
    expect(byId.get('ml-b')?.runner?.addonIds).toEqual(['ml-a', 'ml-b'])
    expect(byId.get('ml-b')?.runner?.pid).toBe(22)
    expect(byId.get('in-process')?.runner).toBeNull()
  })

  it('keeps a runner that hosts no known addon visible as its own row', () => {
    const rows = joinAddonRuntime(addons, [runner('ghost', ['gone-addon'], 33)])
    const stray = rows.find((r) => r.kind === 'runner')
    expect(stray).toMatchObject({ key: 'runner:ghost', addonId: null, status: 'running' })
    expect(stray?.runner?.pid).toBe(33)
    expect(rows.filter((r) => r.kind === 'addon')).toHaveLength(4)
  })

  it('does not invent a group: an addon the process list does not name has no runner', () => {
    const rows = joinAddonRuntime(addons, [runner('ml', ['ml-a'])])
    expect(rows.find((r) => r.key === 'ml-b')?.runner).toBeNull()
  })
})

describe('tolerant readers', () => {
  it('skip unreadable rows instead of throwing', () => {
    expect(
      addonsFromStatus({ addons: [{ id: 'a', status: 'running' }, null, { nope: 1 }] }),
    ).toEqual([{ id: 'a', status: 'running' }])
    expect(addonsFromStatus(null)).toEqual([])
    expect(processesFromList([{ name: 'p', addonIds: ['a', 3] }, 7])).toEqual([
      expect.objectContaining({ name: 'p', addonIds: ['a'], groupId: 'p', pid: 0 }),
    ])
    expect(processesFromList('x')).toEqual([])
  })
})
