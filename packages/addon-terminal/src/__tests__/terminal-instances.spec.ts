import { describe, expect, it, vi } from 'vitest'
import {
  instancesOnAbsentNodes,
  applyTerminalInstancePatch,
  listLegacyTerminalCameraCandidates,
  readTerminalInstances,
  TerminalInstanceMutationQueue,
  TerminalInstanceReconcileCoordinator,
} from '../terminal-instances.js'

describe('readTerminalInstances', () => {
  it('keeps valid distinct instances and ignores malformed or duplicate durable ids', () => {
    const warn = vi.fn()
    const instances = readTerminalInstances(
      [
        {
          id: '018f5846-3ae2-7cb7-9a13-0800200c9a66',
          cameraStableId: 'terminal-camera-instance-018f5846-3ae2-7cb7-9a13-0800200c9a66',
          nodeId: 'agent-a',
          profileId: 'monitor',
          profileLabel: 'BTM',
          name: 'Monitor A',
          enabled: true,
        },
        {
          id: '018f5846-3ae2-7cb7-9a13-0800200c9a67',
          cameraStableId: 'terminal-camera-instance-018f5846-3ae2-7cb7-9a13-0800200c9a67',
          nodeId: 'agent-a',
          profileId: 'monitor',
          profileLabel: 'BTM',
          name: 'Monitor B',
          enabled: true,
        },
        {
          id: '018f5846-3ae2-7cb7-9a13-0800200c9a67',
          cameraStableId: 'terminal-camera-instance-duplicate',
          nodeId: 'agent-a',
          profileId: 'top',
          profileLabel: 'Top',
          name: 'Duplicate',
          enabled: true,
        },
        { id: 'not-a-valid-instance' },
      ],
      warn,
    )

    expect(instances.map((instance) => instance.name)).toEqual(['Monitor A', 'Monitor B'])
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('keeps per-instance profileSettings and defaults the bag when omitted', () => {
    const instances = readTerminalInstances([
      {
        id: '018f5846-3ae2-7cb7-9a13-0800200c9a66',
        cameraStableId: 'terminal-camera-instance-018f5846-3ae2-7cb7-9a13-0800200c9a66',
        nodeId: 'hub',
        profileId: 'glances',
        profileLabel: 'Glances',
        name: 'Glances Hub',
        enabled: true,
        profileSettings: { showProcessList: false },
      },
      {
        id: '018f5846-3ae2-7cb7-9a13-0800200c9a67',
        cameraStableId: 'terminal-camera-instance-018f5846-3ae2-7cb7-9a13-0800200c9a67',
        nodeId: 'hub',
        profileId: 'monitor',
        profileLabel: 'BTM',
        name: 'BTM Hub',
        enabled: true,
      },
    ])
    expect(instances[0]?.profileSettings).toEqual({ showProcessList: false })
    expect(instances[1]?.profileSettings).toEqual({})
  })

  it('serializes concurrent creates and mixed instance mutations without losing rows', async () => {
    const queue = new TerminalInstanceMutationQueue()
    let instances: string[] = []
    const mutate = (apply: (current: readonly string[]) => readonly string[]) =>
      queue.run(async () => {
        const current = [...instances]
        // Model the async persistence/reconcile boundary between read and
        // write. Without the shared queue every caller would write a stale
        // snapshot of this array.
        await Promise.resolve()
        instances = [...apply(current)]
      })

    await Promise.all([
      mutate((current) => [...current, 'monitor-a']),
      mutate((current) => [...current, 'monitor-b']),
    ])
    expect(instances).toEqual(['monitor-a', 'monitor-b'])

    await Promise.all([
      mutate((current) => [...current, 'top-a']),
      mutate((current) => current.filter((id) => id !== 'monitor-a')),
      mutate((current) => [...current, 'monitor-c']),
    ])
    expect(instances).toEqual(['monitor-b', 'top-a', 'monitor-c'])
  })

  it('coalesces stale periodic reconciliation behind delete and disable mutations', async () => {
    const queue = new TerminalInstanceMutationQueue()
    const reconciler = new TerminalInstanceReconcileCoordinator(queue)
    let instances = ['monitor-a']
    let declaredCameras: string[] = []
    const applyDeclarations = async () => {
      const snapshot = [...instances]
      await Promise.resolve()
      declaredCameras = snapshot
    }

    // A periodic pass that started with the old declaration is serialized
    // before the delete; the delete's own camera withdrawal wins afterwards.
    const stalePeriodic = reconciler.request(applyDeclarations)
    const deletion = queue.run(async () => {
      instances = []
      declaredCameras = []
    })
    await Promise.all([stalePeriodic, deletion])
    expect(declaredCameras).toEqual([])

    instances = ['top-a']
    declaredCameras = ['top-a']
    // Config-triggered reconciliation is requested while the disable mutation
    // owns the lane. It runs only after the disabled state has been persisted.
    await queue.run(async () => {
      instances = []
      declaredCameras = []
      void reconciler.request(applyDeclarations)
    })
    await reconciler.request(applyDeclarations)
    expect(declaredCameras).toEqual([])
  })

  it('does not surface a tombstoned legacy camera when its device row lingers', () => {
    const candidates = listLegacyTerminalCameraCandidates(
      [
        {
          id: 811,
          stableId: 'terminal-camera-agent-a',
          name: 'Old BTM',
          config: { nodeId: 'agent-a' },
        },
      ],
      new Set(),
      new Set(['terminal-camera-agent-a']),
    )

    expect(candidates).toEqual([])
  })
})

describe('instancesOnAbsentNodes', () => {
  const on = (id: string, nodeId: string) => ({
    id,
    cameraStableId: `terminal-camera-instance-${id}`,
    nodeId,
    profileId: 'monitor',
    profileLabel: 'BTM',
    name: id,
    enabled: true,
    executable: '',
    args: [],
    cwd: '',
    environment: [],
    profileSettings: {},
  })
  const A = '018f5846-3ae2-7cb7-9a13-0800200c9a66'
  const B = '018f5846-3ae2-7cb7-9a13-0800200c9a67'

  // A node the cluster has FORGOTTEN is not in the topology at all. The
  // instance is KEPT (the operator re-points it); it is only reported, and
  // only when two consecutive reads agree (D49) so one lossy topology answer
  // does not raise an alert.
  it('confirms an absent node only on two consecutive reads, and never names a removal', () => {
    const instances = [on(A, 'hub'), on(B, 'hub-test')]
    const known = new Set(['hub', 'agent-a'])
    const first = instancesOnAbsentNodes(instances, known, new Set())
    expect(first.confirmed).toEqual([])
    expect([...first.absentNow]).toEqual([B])
    const second = instancesOnAbsentNodes(instances, known, first.absentNow)
    expect(second.confirmed.map((i) => i.id)).toEqual([B])
    expect('remove' in second).toBe(false)
  })

  it('a node that reappears clears the streak', () => {
    const instances = [on(B, 'hub-test')]
    const back = instancesOnAbsentNodes(instances, new Set(['hub', 'hub-test']), new Set([B]))
    expect(back.confirmed).toEqual([])
    expect(back.absentNow.size).toBe(0)
  })
})

describe('applyTerminalInstancePatch', () => {
  const base = {
    id: '018f5846-3ae2-7cb7-9a13-0800200c9a66',
    cameraStableId: 'terminal-camera-instance-x',
    nodeId: 'MinidiGianluca.localdomain',
    profileId: 'monitor',
    profileLabel: 'BTM',
    name: 'Glances macmini',
    enabled: true,
    executable: '',
    args: [],
    cwd: '',
    environment: [],
    profileSettings: {},
  }

  it('re-points the instance to another node and takes that node profile label', () => {
    const next = applyTerminalInstancePatch(
      base,
      { instanceId: base.id, targetNodeId: 'agent-bbce9dde' },
      { profileLabel: 'Monitor' },
    )
    expect(next.nodeId).toBe('agent-bbce9dde')
    expect(next.profileLabel).toBe('Monitor')
    expect(next.name).toBe('Glances macmini')
    expect(next.cameraStableId).toBe(base.cameraStableId)
  })

  it('leaves the node alone when no target is given', () => {
    const next = applyTerminalInstancePatch(base, { instanceId: base.id, name: ' x ' })
    expect(next.nodeId).toBe(base.nodeId)
    expect(next.name).toBe('x')
  })
})
