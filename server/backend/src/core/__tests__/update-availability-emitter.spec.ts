import type { IEventBus, SystemEvent } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { UpdateAvailabilityEmitter } from '../update-availability-emitter.js'

function busOf(emit: (event: SystemEvent) => void): IEventBus {
  return { emit } as unknown as IEventBus
}

describe('UpdateAvailabilityEmitter', () => {
  it('deduplicates repeated snapshots and emits again for a new version pair', () => {
    const emit = vi.fn<(event: SystemEvent) => void>()
    const bus = { emit } as unknown as IEventBus
    const updates = new UpdateAvailabilityEmitter(bus, { type: 'core', id: 'updates' })
    const first = {
      target: 'addon' as const,
      packageName: '@camstack/addon-pipeline',
      currentVersion: '1.2.3',
      latestVersion: '1.2.4',
    }

    updates.publishSnapshot('addon', [first])
    updates.publishSnapshot('addon', [first])
    updates.publishSnapshot('addon', [{ ...first, latestVersion: '1.2.5' }])

    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls[0]![0]).toMatchObject({
      category: 'update.available',
      data: { ...first, nodeId: 'hub' },
    })
    expect(emit.mock.calls[1]![0].data).toMatchObject({ latestVersion: '1.2.5' })
  })

  it('emits ONE addon event with the full list when any latest version changes', () => {
    const emit = vi.fn<(event: SystemEvent) => void>()
    const updates = new UpdateAvailabilityEmitter(busOf(emit), { type: 'core', id: 'updates' })
    const pipeline = {
      target: 'addon' as const,
      packageName: '@camstack/addon-pipeline',
      currentVersion: '1.2.3',
      latestVersion: '1.2.4',
    }
    const reolink = {
      target: 'addon' as const,
      packageName: '@camstack/addon-provider-reolink',
      currentVersion: '1.0.0',
      latestVersion: '1.0.1',
    }

    updates.publishSnapshot('addon', [pipeline, reolink])
    updates.publishSnapshot('addon', [pipeline, reolink])
    updates.publishSnapshot('addon', [pipeline, { ...reolink, latestVersion: '1.0.2' }])

    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls[0]![0].data).toMatchObject({
      target: 'addon',
      packages: [
        {
          packageName: pipeline.packageName,
          currentVersion: pipeline.currentVersion,
          latestVersion: pipeline.latestVersion,
        },
        {
          packageName: reolink.packageName,
          currentVersion: reolink.currentVersion,
          latestVersion: reolink.latestVersion,
        },
      ],
    })
    expect(emit.mock.calls[1]![0].data).toMatchObject({
      packages: [
        {
          packageName: pipeline.packageName,
          currentVersion: pipeline.currentVersion,
          latestVersion: pipeline.latestVersion,
        },
        {
          packageName: reolink.packageName,
          currentVersion: reolink.currentVersion,
          latestVersion: '1.0.2',
        },
      ],
    })
  })

  it('does not re-emit the addon list when only a current version drops off after an install', () => {
    const emit = vi.fn<(event: SystemEvent) => void>()
    const updates = new UpdateAvailabilityEmitter(busOf(emit), { type: 'core', id: 'updates' })
    const pipeline = {
      target: 'addon' as const,
      packageName: '@camstack/addon-pipeline',
      currentVersion: '1.2.3',
      latestVersion: '1.2.4',
    }
    const reolink = {
      target: 'addon' as const,
      packageName: '@camstack/addon-provider-reolink',
      currentVersion: '1.0.0',
      latestVersion: '1.0.1',
    }

    updates.publishSnapshot('addon', [pipeline, reolink])
    updates.publishSnapshot('addon', [reolink])

    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('announces ONE node per event — a node sweep never re-lists another node', () => {
    // The bug this pins, from the hub's own log on 2026-08-19: one 6-hourly
    // sweep sent THREE "aggiornamenti addon disponibili" pushes to the phone,
    // each carrying the union of hub + MacMiniAgent + agent-a, because
    // every scope's change re-emitted the WHOLE held map. Three notifications
    // that looked identical and named no node.
    const emit = vi.fn<(event: SystemEvent) => void>()
    const updates = new UpdateAvailabilityEmitter(busOf(emit), { type: 'core', id: 'updates' })
    const hub = {
      target: 'addon' as const,
      packageName: '@camstack/addon-pipeline',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
    }
    const agent = {
      target: 'addon' as const,
      packageName: '@camstack/addon-ai',
      currentVersion: '0.4.8',
      latestVersion: '0.4.13',
      nodeId: 'agent-a',
    }

    updates.publishSnapshot('addon', [hub])
    updates.publishSnapshot('addon', [agent], 'agent-a')

    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls[0]![0].data).toMatchObject({
      nodeId: 'hub',
      nodeIds: ['hub'],
      // Even the hub's own rows say which node they are about — a list with
      // unlabelled lines in it cannot be read on a cluster.
      packages: [{ packageName: '@camstack/addon-pipeline', nodeId: 'hub' }],
    })
    expect(emit.mock.calls[1]![0].data).toMatchObject({
      nodeId: 'agent-a',
      nodeIds: ['agent-a'],
      packages: [{ packageName: '@camstack/addon-ai', nodeId: 'agent-a' }],
    })
    expect(emit.mock.calls[1]![0].data['packages']).toHaveLength(1)
  })

  it('emits the server snapshot per node, and a node that did not change stays quiet', () => {
    const emit = vi.fn<(event: SystemEvent) => void>()
    const updates = new UpdateAvailabilityEmitter(busOf(emit), { type: 'core', id: 'updates' })
    const hub = {
      target: 'server' as const,
      packageName: '@camstack/server',
      currentVersion: '1.0.1',
      latestVersion: '1.0.2',
      nodeId: 'hub',
    }
    const agent = { ...hub, nodeId: 'agent-a' }

    updates.publishSnapshot('server', [hub], 'hub')
    updates.publishSnapshot('server', [agent], 'agent-a')
    updates.publishSnapshot('server', [{ ...hub, latestVersion: '1.0.3' }], 'hub')

    expect(emit).toHaveBeenCalledTimes(3)
    expect(emit.mock.calls[0]![0].data).toMatchObject({ target: 'server', nodeIds: ['hub'] })
    expect(emit.mock.calls[1]![0].data).toMatchObject({ nodeIds: ['agent-a'] })
    expect(emit.mock.calls[2]![0].data).toMatchObject({
      latestVersion: '1.0.3',
      nodeIds: ['hub'],
    })
  })

  it('keeps hub and agent addon snapshots independent', () => {
    const emit = vi.fn<(event: SystemEvent) => void>()
    const updates = new UpdateAvailabilityEmitter({ emit } as unknown as IEventBus, {
      type: 'core',
      id: 'updates',
    })
    const hub = {
      target: 'addon' as const,
      packageName: '@camstack/addon-pipeline',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
    }
    const agent = { ...hub, nodeId: 'agent-a' }

    updates.publishSnapshot('addon', [hub])
    updates.publishSnapshot('addon', [agent], 'agent-a')
    updates.publishSnapshot('addon', [hub])

    expect(emit).toHaveBeenCalledTimes(2)
  })
})
