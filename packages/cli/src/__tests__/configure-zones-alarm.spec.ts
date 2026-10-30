import { describe, expect, it } from 'vitest'
import { alarmSet, readAlarm, readZonesTool, zoneUpsert } from '../mcp/configure-zones-alarm.js'
import { withWrites } from './configure-gate-ctx.js'
import { fakeHub } from './ops-fake-hub.js'

const ZONE = {
  id: 'z-1',
  name: 'Gate',
  kind: 'polygon',
  polygon: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
  ],
  color: '#ff0000',
}
const square = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.9 },
]

describe('configure_zones', () => {
  it('lists zones and summarises the motion mask without dumping the grid', async () => {
    const { ctx } = fakeHub({
      'zones.listZones': [ZONE],
      'motionZones.getStatus': {
        grid: [
          [1, 0, 0],
          [0, 1, 1],
        ],
      },
    })
    const out = await readZonesTool(ctx, { deviceId: 7 })
    expect(out).toMatchObject({
      zones: [{ id: 'z-1', name: 'Gate', points: 3 }],
      motionMask: { rows: 2, columns: 3, cellsDrawn: 3 },
    })
    expect(JSON.stringify(out)).not.toContain('"grid"')
  })
})

describe('configure_zone_upsert', () => {
  const base = {
    'zones.listZones': [ZONE],
    'zones.addZone': undefined,
    'zones.updateZone': undefined,
  }

  it('adds a zone with normalised points through addZone, assigning an id', async () => {
    const { ctx, calls } = fakeHub(base)
    const w = withWrites(ctx)
    const args = {
      deviceId: 7,
      name: 'Lawn',
      kind: 'polygon' as const,
      points: square,
    }
    const preview = await zoneUpsert(w, args, undefined)
    if (preview.status !== 'dry-run') throw new Error(JSON.stringify(preview))
    await zoneUpsert(w, args, preview.confirm_token)
    const sent = calls.find((c) => c.path === 'zones.addZone')?.input
    expect(sent).toMatchObject({
      deviceId: 7,
      zone: { name: 'Lawn', kind: 'polygon', polygon: square },
    })
  })

  it('updates the named zone and keeps its colour', async () => {
    const { ctx, calls } = fakeHub(base)
    const w = withWrites(ctx)
    const args = {
      deviceId: 7,
      zoneId: 'z-1',
      name: 'Gate',
      kind: 'polygon' as const,
      points: square,
    }
    const preview = await zoneUpsert(w, args, undefined)
    if (preview.status !== 'dry-run') throw new Error(JSON.stringify(preview))
    await zoneUpsert(w, args, preview.confirm_token)
    expect(calls.find((c) => c.path === 'zones.updateZone')?.input).toMatchObject({
      zone: { id: 'z-1', color: '#ff0000' },
    })
  })

  it('refuses a polygon of two points, a name clash and an unknown zone id', async () => {
    const { ctx } = fakeHub(base)
    const w = withWrites(ctx)
    const text = async (a: object): Promise<string> =>
      JSON.stringify(
        await zoneUpsert(
          w,
          { deviceId: 7, name: 'X', kind: 'polygon', points: square, ...a },
          undefined,
        ),
      )
    expect(await text({ points: square.slice(0, 2) })).toMatch(/at least 3 points/)
    expect(await text({ name: 'gate' })).toMatch(/already exists/)
    expect(await text({ zoneId: 'nope' })).toMatch(/has no zone nope/)
  })
})

const PANEL_DEVICES = [
  { id: 30, name: 'Panel', type: 'alarm-panel' },
  { id: 7, name: 'Cam', type: 'camera' },
]
const OPEN_PANEL = {
  state: 'disarmed',
  targetMode: null,
  availableModes: ['home', 'away'],
  requiresCode: false,
  lastChangedAt: 1,
}

describe('configure_alarm', () => {
  it('reads only alarm panels', async () => {
    const { ctx } = fakeHub({
      'deviceManager.listAll': PANEL_DEVICES,
      'alarmPanel.getStatus': OPEN_PANEL,
    })
    const out = await readAlarm(ctx, {})
    expect(out).toMatchObject({
      panels: [{ deviceId: 30, state: 'disarmed', requiresCode: false }],
    })
  })
})

describe('configure_alarm_set', () => {
  it('arms a PIN-less panel in an offered mode, after a preview', async () => {
    const { ctx, calls } = fakeHub({
      'alarmPanel.getStatus': OPEN_PANEL,
      'alarmPanel.arm': undefined,
    })
    const w = withWrites(ctx)
    const args = {
      deviceId: 30,
      action: 'arm' as const,
      mode: 'away' as const,
    }
    const preview = await alarmSet(w, args, undefined)
    if (preview.status !== 'dry-run') throw new Error(JSON.stringify(preview))
    expect(calls.some((c) => c.path === 'alarmPanel.arm')).toBe(false)
    await alarmSet(w, args, preview.confirm_token)
    expect(calls.find((c) => c.path === 'alarmPanel.arm')?.input).toEqual({
      deviceId: 30,
      mode: 'away',
    })
  })

  it('answers secret-required, never asking for the PIN, when the panel needs one', async () => {
    const { ctx, calls } = fakeHub({
      'alarmPanel.getStatus': { ...OPEN_PANEL, requiresCode: true },
      'localNetwork.getAddresses': {
        roles: { appConnections: { resolved: ['http://192.168.1.9:4443'] } },
      },
    })
    const out = await alarmSet(withWrites(ctx), { deviceId: 30, action: 'disarm' }, undefined)
    expect(JSON.stringify(out)).toMatch(/secret-required/)
    expect(JSON.stringify(out)).toContain('192.168.1.9')
    expect(calls.some((c) => c.path === 'alarmPanel.disarm')).toBe(false)
  })

  it('refuses a mode the panel does not take', async () => {
    const { ctx } = fakeHub({ 'alarmPanel.getStatus': OPEN_PANEL })
    const out = await alarmSet(
      withWrites(ctx),
      { deviceId: 30, action: 'arm', mode: 'night' },
      undefined,
    )
    expect(JSON.stringify(out)).toMatch(/does not take/)
  })
})
