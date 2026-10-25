import { describe, expect, it, vi } from 'vitest'
import { ShcClient } from '../shc-client.js'
import { parseShcDeviceList } from '../shc-parse-devices.js'

describe('parseShcDeviceList', () => {
  it('parses a wrapped device list with service ids', () => {
    const devices = parseShcDeviceList({
      '@type': 'deviceList',
      devices: [
        {
          '@type': 'device',
          id: 'roomClimateControl_hz_1',
          deviceModel: 'ROOM_CLIMATE_CONTROL',
          name: 'Living',
          deviceServiceData: [{ id: 'RoomClimateControl' }],
        },
      ],
    })
    expect(devices).toHaveLength(1)
    expect(devices[0]?.services).toContain('RoomClimateControl')
  })

  it('parses the bare array the controller actually returns', () => {
    const devices = parseShcDeviceList([
      {
        '@type': 'device',
        id: 'roomClimateControl_hz_1',
        deviceModel: 'ROOM_CLIMATE_CONTROL',
        name: '-RoomClimateControl-',
        roomId: 'hz_1',
        deviceServiceIds: ['RoomClimateControl'],
      },
    ])
    expect(devices).toHaveLength(1)
    expect(devices[0]?.services).toContain('RoomClimateControl')
    expect(devices[0]?.roomId).toBe('hz_1')
  })

  it('copies childDeviceIds and parentDeviceId when present', () => {
    const devices = parseShcDeviceList([
      {
        id: 'roomClimateControl_hz_1',
        deviceModel: 'ROOM_CLIMATE_CONTROL',
        name: 'Office',
        childDeviceIds: ['hdm1:trv1'],
      },
      {
        id: 'hdm1:trv1',
        deviceModel: 'TRV_GEN2_DUAL',
        name: 'TRV',
        parentDeviceId: 'roomClimateControl_hz_1',
      },
    ])
    expect(devices[0]?.childDeviceIds).toEqual(['hdm1:trv1'])
    expect(devices[1]?.parentDeviceId).toBe('roomClimateControl_hz_1')
  })
})

describe('nameShcDevices', () => {
  it('replaces the controller placeholder with the room name', async () => {
    const { nameShcDevices } = await import('../shc-parse-devices.js')
    const named = nameShcDevices(
      [
        {
          id: 'roomClimateControl_hz_1',
          deviceModel: 'ROOM_CLIMATE_CONTROL',
          name: '-RoomClimateControl-',
          services: ['RoomClimateControl'],
          roomId: 'hz_1',
        },
        {
          id: 'trv-1',
          deviceModel: 'TRV_GEN2_DUAL',
          name: 'Termosifone porch',
          services: ['ValveTappet'],
          roomId: 'hz_1',
        },
      ],
      [{ id: 'hz_1', name: 'porch' }],
    )
    expect(named[0]?.name).toBe('porch')
    expect(named[1]?.name).toBe('Termosifone porch')
  })
})

describe('ShcClient', () => {
  it('listDevices calls smarthome REST with mTLS fetch seam', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        devices: [{ id: 'd1', deviceModel: 'TWR_SWITCH', name: 'Plug', deviceServiceData: [] }],
      }),
    )
    const client = new ShcClient(
      {
        host: '192.168.1.10',
        sslCertificate: 'CERT',
        sslKey: 'KEY',
      },
      { fetchImpl },
    )
    const devices = await client.listDevices()
    expect(devices).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://192.168.1.10:8444/smarthome/devices',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('putServiceState sends climateControlState body', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }))
    const client = new ShcClient(
      { host: 'shc.local', sslCertificate: 'C', sslKey: 'K' },
      { fetchImpl },
    )
    await client.putServiceState('dev1', 'RoomClimateControl', {
      '@type': 'climateControlState',
      setpointTemperature: 22,
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://shc.local:8444/smarthome/devices/dev1/services/RoomClimateControl/state',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ '@type': 'climateControlState', setpointTemperature: 22 }),
      }),
    )
  })

  it('subscribes on JSON-RPC and emits the long-poll device id', async () => {
    let longPolls = 0
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string }
      if (body.method === 'RE/subscribe') {
        return Response.json({ result: 'sub-1', jsonrpc: '2.0' })
      }
      if (body.method === 'RE/longPoll') {
        longPolls += 1
        if (longPolls === 1) {
          return Response.json({
            jsonrpc: '2.0',
            result: [{ deviceId: 'roomClimateControl_hz_5', id: 'RoomClimateControl' }],
          })
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        })
      }
      return Response.json({ result: null, jsonrpc: '2.0' })
    })
    const client = new ShcClient(
      { host: 'shc.local', sslCertificate: 'C', sslKey: 'K' },
      { fetchImpl },
    )
    const seen: string[] = []
    client.onStateChange((event) => {
      if (event.deviceId !== undefined) seen.push(event.deviceId)
    })
    client.startLongPoll()
    await vi.waitFor(() => {
      expect(seen).toContain('roomClimateControl_hz_5')
    })
    client.stopLongPoll()
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://shc.local:8444/remote/json-rpc',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
