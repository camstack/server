/**
 * Which nodes the log settings are copied to. `nodes.directory` is the hub's live registry plus
 * the durable node history, so an agent that is offline right now is still listed; an incomplete
 * answer or an unreadable directory fails the migration instead of copying to part of the fleet.
 */
import { describe, expect, it } from 'vitest'
import { clusterNodeIds } from '../node-fields.js'

const directory =
  (ids: readonly string[], complete = true) =>
  async () => ({
    nodes: ids.map((id) => ({ id })),
    complete,
  })

describe('clusterNodeIds', () => {
  it('lists an offline agent the directory knows', async () => {
    expect(await clusterNodeIds(directory(['hub', 'agent-offline']), 'hub')).toEqual([
      'hub',
      'agent-offline',
    ])
  })

  it('takes the node id before the first slash of the local node id and dedupes it', async () => {
    expect(await clusterNodeIds(directory(['hub', 'agent-1']), 'hub/runner-3')).toEqual([
      'hub',
      'agent-1',
    ])
  })

  it('falls back to hub when the local node id is unknown or empty, even if the directory is empty', async () => {
    expect(await clusterNodeIds(directory([]), undefined)).toEqual(['hub'])
    expect(await clusterNodeIds(directory([]), '')).toEqual(['hub'])
  })

  it('rejects when the directory throws', async () => {
    await expect(
      clusterNodeIds(async () => {
        throw new Error('hub unreachable')
      }, 'hub'),
    ).rejects.toThrow('hub unreachable')
  })

  it('rejects when the directory says it is incomplete', async () => {
    await expect(clusterNodeIds(directory(['hub'], false), 'hub')).rejects.toThrow(/incomplete/)
  })
})
