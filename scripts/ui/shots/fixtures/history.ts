/**
 * Device history (D850, D896): the device page's History tab, the camera's
 * Live Stats tab and the cross-device History page (`/system/history`).
 *
 * Two invented non-camera devices join the cameras of `camera.ts`:
 * 201 "Living room thermostat" (climate: temperature, target, humidity,
 * battery, online) and 202 "Dishwasher" (program state, progress, power,
 * energy meter and the derived energy per bucket). Camera 101 carries the
 * analytics producer series (motion, audio, occupancy per zone × class) and
 * an online flag that drops overnight. Node series cover two nodes and two
 * storage locations. One saved panel sits in the account preferences.
 *
 * Load this area BEFORE `camera` (`--fixtures history,camera`): it answers
 * device reads for 201/202 and hands every other id to the camera area.
 */
import cameraArea from './camera'
import { DEVICE_SERIES, NODE_SERIES, queryResult, seriesInfo } from './_history-data'
import { defineFixtures } from './_define'
import { D, NOW } from './_time'

const device = (
  id: number,
  name: string,
  type: string,
  addonId: string,
  location: string,
  model: string,
) => ({
  id,
  stableId: `dev-${id}`,
  addonId,
  type,
  name,
  location,
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: { manufacturer: 'Example', model, firmware: '2.4.1' },
})

const DEVICES: Readonly<Record<number, ReturnType<typeof device>>> = {
  201: device(
    201,
    'Living room thermostat',
    'climate',
    'provider-homematic',
    'Living room',
    'HM-TC-IT',
  ),
  202: device(202, 'Dishwasher', 'dishwasher', 'provider-homeconnect', 'Kitchen', 'SMV6ZCX'),
}

const cameraHandler = (path: string): ((i: unknown) => unknown) | undefined => {
  const h = cameraArea.handlers[path]
  return typeof h === 'function' ? (i: unknown) => (h as (x: unknown) => unknown)(i) : undefined
}

const emptyAggregate = (deviceId: number) => ({
  settings: { tabs: [], sections: [] },
  live: { sections: [] },
  tabs: undefined,
  deviceId,
})

interface QueryManyItem {
  readonly deviceId?: number
  readonly forNodeId?: string
  readonly key: string
  readonly scope?: string
}

const answerItem = (item: QueryManyItem, from: number, to: number) => {
  const list =
    item.deviceId !== undefined
      ? DEVICE_SERIES[item.deviceId]
      : item.forNodeId !== undefined
        ? NODE_SERIES[item.forNodeId]
        : undefined
  if (list === undefined) return { ok: false, error: 'no such subject' }
  return { ok: true, result: queryResult(list, item.key, item.scope, from, to) }
}

const PANELS_ROW = {
  namespace: 'admin.history-panels',
  revision: 3,
  updatedAt: NOW - 2 * D,
  updatedByDevice: null,
  value: {
    version: 1,
    panels: [
      {
        id: 'panel-kitchen',
        name: 'Kitchen power',
        window: '7d',
        selection: [
          { subject: { kind: 'device', deviceId: 202 }, key: 'cap:power-meter.power', scope: '' },
          { subject: { kind: 'device', deviceId: 202 }, key: 'cap:dishwasher.state', scope: '' },
        ],
      },
    ],
    hidden: {},
  },
}

const LIST_ALL = [
  ...[101, 102].map((id) => {
    const get = cameraHandler('deviceManager.getDevice')
    return get ? get({ deviceId: id }) : null
  }),
  ...Object.values(DEVICES),
].filter((d) => d !== null)

/**
 * Series no longer linked to a device (D917): two of a removed device 205
 * (departure clock running) and two undeclared tank levels of the dishwasher.
 */
const orphan = (
  seriesId: number,
  deviceId: number,
  key: string,
  displayName: string | null,
  reason: 'device-gone' | 'undeclared',
  raw: number,
) => ({
  seriesId,
  deviceId,
  key,
  scope: '',
  displayName,
  reason,
  missingSince: reason === 'device-gone' ? NOW - 3 * D : null,
  firstTs: NOW - 90 * D,
  lastTs: reason === 'device-gone' ? NOW - 3 * D : NOW - 21 * D,
  rows: { raw, '5m': Math.round(raw / 5), '1h': Math.round(raw / 60), '1d': 90 },
})

const ORPHANS = {
  series: [
    orphan(901, 205, 'cap:climate.temperature', 'Temperature', 'device-gone', 25_920),
    orphan(902, 205, 'cap:battery.level', 'Battery', 'device-gone', 1_310),
    orphan(903, 202, 'cap:vacuum-control.cleanWater.level', null, 'undeclared', 0),
    orphan(904, 202, 'cap:vacuum-control.dirtyWater.level', 'Dirty water', 'undeclared', 412),
  ],
  truncated: false,
}

export default defineFixtures({
  area: 'history',
  description:
    'Device history: a thermostat, a dishwasher and camera 101 with recorded series, node and storage series, one saved panel, four orphan series',
  handlers: {
    'deviceManager.getDevice': (i: { deviceId: number }) =>
      DEVICES[i.deviceId] ?? cameraHandler('deviceManager.getDevice')?.(i) ?? null,
    'deviceManager.getDeviceAggregate': (i: { deviceId: number }) =>
      DEVICES[i.deviceId] !== undefined
        ? emptyAggregate(i.deviceId)
        : (cameraHandler('deviceManager.getDeviceAggregate')?.(i) ?? null),
    'deviceManager.getBindings': (i: { deviceId: number }) =>
      DEVICES[i.deviceId] !== undefined
        ? { deviceId: i.deviceId, entries: [] }
        : (cameraHandler('deviceManager.getBindings')?.(i) ?? null),
    'deviceManager.listAll': LIST_ALL,
    // No alert popover over the charts being shot.
    'alerts.list': [],
    'alerts.getUnreadCount': 0,
    'auth.listLoginMethods': [],
    'capabilities.getCapability': (i: { name: string }) => ({
      name: i.name,
      mode: 'singleton',
      providers: [i.name],
      activeProvider: i.name,
      disabledProviders: [],
    }),
    'deviceHistory.listSeries': (i: { deviceId: number }) =>
      seriesInfo(DEVICE_SERIES[i.deviceId] ?? []),
    'deviceHistory.listNodeSeries': (i: { forNodeId: string }) =>
      seriesInfo(NODE_SERIES[i.forNodeId] ?? []),
    'deviceHistory.query': (i: {
      deviceId: number
      key: string
      scope?: string
      from: number
      to: number
    }) => queryResult(DEVICE_SERIES[i.deviceId] ?? [], i.key, i.scope, i.from, i.to),
    'deviceHistory.queryNode': (i: {
      forNodeId: string
      key: string
      scope?: string
      from: number
      to: number
    }) => queryResult(NODE_SERIES[i.forNodeId] ?? [], i.key, i.scope, i.from, i.to),
    'deviceHistory.queryMany': (i: {
      items: readonly QueryManyItem[]
      from: number
      to: number
    }) => ({
      results: i.items.map((item) => answerItem(item, i.from, i.to)),
    }),
    'deviceHistory.getDeviceEnabled': { enabled: true },
    'deviceHistory.listOrphanSeries': ORPHANS,
    // 904 came back between the listing and the delete: the hub refuses it.
    'mut:deviceHistory.deleteOrphanSeries': (i: { seriesIds: readonly number[] }) => ({
      results: i.seriesIds.map((seriesId) => {
        const s = ORPHANS.series.find((o) => o.seriesId === seriesId)
        if (s === undefined) return { seriesId, ok: false, reason: 'not-found' }
        if (seriesId === 904) return { seriesId, ok: false, reason: 'not-orphan' }
        return { seriesId, ok: true, deleted: s.rows }
      }),
    }),
    'storage.listLocations': [
      {
        id: 'recordings:fast-ssd',
        type: 'recordings',
        displayName: 'Fast SSD',
        providerId: 'fs',
        config: {},
        nodeId: 'hub',
      },
      {
        id: 'eventMedia:array',
        type: 'eventMedia',
        displayName: 'Array',
        providerId: 'fs',
        config: {},
        nodeId: 'hub',
      },
    ],
    'preferences.get': (i: { namespaces?: readonly string[] }) => ({
      rows:
        i.namespaces === undefined || i.namespaces.includes(PANELS_ROW.namespace)
          ? [PANELS_ROW]
          : [],
    }),
    'mut:preferences.put': (i: { namespace: string; value: Record<string, unknown> }) => ({
      status: 'saved',
      row: {
        ...PANELS_ROW,
        namespace: i.namespace,
        value: i.value,
        revision: PANELS_ROW.revision + 1,
      },
    }),
  },
})
