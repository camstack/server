import { describe, expect, it } from 'vitest'
import { opsStatus } from '../mcp/ops-status.js'
import { opsDevice, opsUnhealthyDevices } from '../mcp/ops-device.js'
import { fakeHub, noSessionContext } from './ops-fake-hub.js'

const node = (id: string, extra: object = {}): object => ({
  id,
  isOnline: true,
  isHub: id === 'hub',
  addons: [{ capabilities: ['a', 'b'] }, { capabilities: ['b', 'c'] }],
  ...extra,
})

describe('ops_status', () => {
  it('answers no-session without a hub', async () => {
    const out = await opsStatus(noSessionContext())
    expect(out).toMatchObject({ status: 'no-session' })
  })

  it('summarises nodes, versions, capless nodes, alerts and updates', async () => {
    const { ctx, calls } = fakeHub({
      'nodes.topology': [
        node('hub'),
        node('agent-1', { addons: [], capabilitiesRegistered: false }),
        node('agent-2', { isOnline: false }),
      ],
      'serverManagement.getServerPackageStatus': (i: unknown) => ({
        runningVersion: i === undefined ? '1.2.3' : '1.2.0',
      }),
      'alerts.list': [
        { severity: 'warning', title: 'w', status: 'active' },
        { severity: 'critical', title: 'c', status: 'active' },
        { severity: 'info', title: 'old', status: 'resolved' },
      ],
      'addons.listUpdates': [{ name: 'x', currentVersion: '1', latestVersion: '2' }],
    })
    const out = await opsStatus(ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    const byId = Object.fromEntries((out.nodes ?? []).map((n) => [n.id, n]))
    expect(byId['hub']).toMatchObject({
      serverVersion: '1.2.3',
      capabilityCount: 3,
      flags: [],
    })
    expect(byId['agent-1']).toMatchObject({
      serverVersion: '1.2.0',
      flags: ['online-but-capless'],
    })
    expect(byId['agent-2']).toMatchObject({
      online: false,
      serverVersion: null,
    })
    expect(out.alerts).toMatchObject({
      active: 2,
      top: [{ severity: 'critical' }, { severity: 'warning' }],
    })
    expect(out.addonsNeedingUpdate?.items).toEqual([{ name: 'x', from: '1', to: '2' }])
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(JSON.stringify(out)).not.toContain('tok-should-never')
  })

  it('reports a failed read as null with a reason, never an empty list', async () => {
    const { ctx } = fakeHub({
      'nodes.topology': new Error('boom'),
      'alerts.list': new Error('down'),
      'addons.listUpdates': [],
    })
    const out = await opsStatus(ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.nodes).toBeNull()
    expect(out.alerts).toBeNull()
    expect(out.addonsNeedingUpdate).toEqual({ items: [], truncated: 0 })
    expect(out.unavailable['nodes']).toContain('boom')
    expect(out.unavailable['alerts']).toContain('down')
  })

  it('does not call admin-only procedures with a protected credential', async () => {
    const { ctx, calls } = fakeHub({ 'alerts.list': [] }, 'protected')
    const out = await opsStatus(ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.nodes).toBeNull()
    expect(out.unavailable['nodes']).toContain('admin')
    expect(calls.map((c) => c.path)).toEqual(['alerts.list'])
  })
})

const cameraStatus = (deviceId: number, over: object = {}): object => ({
  deviceId,
  assignment: {
    detectionNodeId: 'hub',
    decoderNodeId: 'hub',
    sourceNodeId: 'hub',
  },
  broker: null,
  detection: null,
  recording: { mode: 'continuous', active: true, storageBytes: 1 },
  switchedOff: [],
  degraded: [],
  fetchedAt: 1,
  ...over,
})

const unassigned = (reasons?: object): object => ({
  detectionNodeId: null,
  decoderNodeId: null,
  sourceNodeId: 'hub',
  ...(reasons ? { reasons } : {}),
})

describe('ops_unhealthy_devices', () => {
  const devices = [
    { id: 1, name: 'cam-ok', online: true },
    { id: 2, name: 'cam-offline', online: false },
    { id: 3, name: 'cam-unassigned', online: true },
    { id: 4, name: 'cam-on-motion', online: true },
    { id: 5, name: 'cam-off-by-operator', online: true },
    { id: 6, name: 'cam-disabled', online: true, disabled: true },
    { id: 7, name: 'cam-unreadable', online: true },
  ]
  const statuses = [
    cameraStatus(1),
    cameraStatus(3, { assignment: unassigned() }),
    cameraStatus(4, {
      assignment: unassigned({ detection: 'armed:on-motion' }),
    }),
    cameraStatus(5, {
      assignment: unassigned(),
      switchedOff: ['object-detection'],
    }),
    cameraStatus(7, {
      assignment: unassigned(),
      degraded: [{ stage: 'detection', reason: 'timeout' }],
    }),
  ]

  it('names real faults and leaves by-design and switched-off cameras alone', async () => {
    const { ctx } = fakeHub({
      'deviceManager.listAll': devices,
      'pipelineOrchestrator.getCameraStatuses': statuses,
    })
    const out = await opsUnhealthyDevices(ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    const codes = Object.fromEntries(
      out.unhealthy.map((d) => [d.deviceId, d.reasons.map((r) => r.code)]),
    )
    expect(codes).toEqual({ 2: ['offline'], 3: ['detection-not-assigned'] })
    expect(out.unknown.map((u) => u.deviceId)).toEqual([7])
    expect(out.checked).toBe(6)
  })

  it('says the statuses are unavailable instead of calling everything healthy', async () => {
    const { ctx } = fakeHub({
      'deviceManager.listAll': devices,
      'pipelineOrchestrator.getCameraStatuses': new Error('orchestrator down'),
    })
    const out = await opsUnhealthyDevices(ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.unavailable['cameraStatuses']).toContain('orchestrator down')
  })
})

describe('ops_device', () => {
  const answers = {
    'deviceManager.getDevice': {
      id: 9,
      name: 'Porch',
      type: 'camera',
      isCamera: true,
      online: true,
      disabled: false,
    },
    'deviceManager.getBindings': {
      entries: [
        {
          capName: 'snapshot',
          kind: 'native',
          providerAddonId: 'p',
          providerNodeId: 'hub',
        },
      ],
    },
    'deviceManager.getDeviceStatusAggregate': {
      'device-status': { lastFetchedAt: 9_000, lastChangedAt: 4_000 },
    },
    'pipelineOrchestrator.getCameraStatus': cameraStatus(9, {
      switchedOff: ['recording'],
    }),
    'pipelineAnalytics.getObjectEvents': [
      { id: 1, timestamp: 5, className: 'person', trackId: 't' },
    ],
  }

  it('reports freshness, pipeline and why a function is off', async () => {
    const { ctx } = fakeHub(answers)
    const out = await opsDevice(ctx, 9, 10_000)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.found).toBe(true)
    expect(out.runtimeState).toEqual({
      newestFetchAgeMs: 1000,
      oldestFetchAgeMs: 1000,
      statusChangedAgeMs: 6000,
    })
    expect(out.whyOff).toEqual([
      {
        function: 'recording',
        reason: 'switched off by an operator (not a fault)',
      },
    ])
    expect(out.recentEvents).toHaveLength(1)
  })

  it('a missing device is found:false, a failed read is unknown', async () => {
    const missing = await opsDevice(fakeHub({ ...answers, 'deviceManager.getDevice': null }).ctx, 9)
    expect(missing).toMatchObject({ found: false })
    const failed = await opsDevice(
      fakeHub({ ...answers, 'deviceManager.getDevice': new Error('x') }).ctx,
      9,
    )
    if (failed.status !== 'ok') throw new Error('expected ok')
    expect(failed.found).toBeNull()
    expect(failed.unavailable['device']).toContain('x')
  })
})
