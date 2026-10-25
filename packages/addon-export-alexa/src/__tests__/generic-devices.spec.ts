/**
 * R5 — non-camera devices exported like HomeKit does, where Alexa has an
 * interface (D775).
 */
import type { AddonContext } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildGenericDeviceEndpoint } from '../endpoints/generic-device.js'
import { buildEndpointsForExposedDevice } from '../handlers/discovery.js'
import { genericPropertyFor } from '../handlers/generic-state.js'
import { handleLock } from '../handlers/lock-controller.js'
import { stateReportsFor } from '../state-reports/state-change-map.js'
import { fakeBuildContext, quietLogger } from './helpers/fake-device-api.js'

describe('generic endpoint shape', () => {
  it('a lock is a SMARTLOCK with LockController and EndpointHealth', () => {
    const e = buildGenericDeviceEndpoint({
      deviceId: 5,
      stableId: 's',
      name: 'Front lock',
      type: 'lock',
      capNames: ['lock-control'],
    })
    expect(e?.endpointId).toBe('5__dev')
    expect(e?.displayCategories).toEqual(['SMARTLOCK'])
    expect(e?.capabilities.map((c) => c.interface)).toEqual([
      'Alexa',
      'Alexa.LockController',
      'Alexa.EndpointHealth',
    ])
  })

  it('a switch with brightness is a LIGHT; motion + presence declare MotionSensor once', () => {
    expect(
      buildGenericDeviceEndpoint({
        deviceId: 1,
        stableId: 's',
        name: 'x',
        type: 'switch',
        capNames: ['switch', 'brightness'],
      })?.displayCategories,
    ).toEqual(['LIGHT'])
    const both = buildGenericDeviceEndpoint({
      deviceId: 1,
      stableId: 's',
      name: 'x',
      type: 'sensor',
      capNames: ['motion', 'presence'],
    })
    expect(both?.capabilities.filter((c) => c.interface === 'Alexa.MotionSensor')).toHaveLength(1)
  })

  it('smoke, CO and leak sensors have no Alexa interface — no endpoint, not a fake one', async () => {
    const eps = await buildEndpointsForExposedDevice(
      1,
      fakeBuildContext([
        { id: 1, name: 'Smoke', type: 'sensor', capNames: ['smoke', 'carbon-monoxide', 'flood'] },
      ]),
    )
    expect(eps).toEqual([])
  })
})

describe('generic state', () => {
  it('maps every slice the way Amazon names it', () => {
    expect(genericPropertyFor('contact', { entryOpen: true })).toMatchObject({
      namespace: 'Alexa.ContactSensor',
      value: 'DETECTED',
    })
    expect(genericPropertyFor('lock-control', { state: 'unlocking' })?.value).toBe('UNLOCKED')
    expect(genericPropertyFor('lock-control', { state: 'jammed' })?.value).toBe('JAMMED')
    expect(genericPropertyFor('temperature-sensor', { celsius: 21.34 })?.value).toEqual({
      value: 21.3,
      scale: 'CELSIUS',
    })
    expect(genericPropertyFor('humidity-sensor', { percent: 48 })?.value).toEqual({ value: 48 })
    expect(genericPropertyFor('presence', { state: 'not_home' })?.value).toBe('NOT_DETECTED')
  })

  it('a lock change on an exported lock becomes a LockController report', () => {
    const out = stateReportsFor(
      { deviceId: 5, capName: 'lock-control', slice: { state: 'locked' } },
      { 5: ['5__dev'] },
    )
    expect(out).toEqual({
      kind: 'reports',
      reports: [
        {
          exposedDeviceId: 5,
          endpointId: '5__dev',
          interfaceName: 'Alexa.LockController',
          properties: [{ namespace: 'Alexa.LockController', name: 'lockState', value: 'LOCKED' }],
        },
      ],
    })
  })
})

describe('LockController directive', () => {
  it('locks through lock-control and answers lockState in the context', async () => {
    const lock = vi.fn(async () => undefined)
    const ctx = {
      api: {
        lockControl: {
          lock: { mutate: lock },
          unlock: { mutate: vi.fn() },
          getStatus: { query: async () => ({ state: 'locked', lastChangedAt: 1 }) },
        },
      },
    } as unknown as AddonContext
    const res = (await handleLock(
      {
        namespace: 'Alexa.LockController',
        name: 'Lock',
        payloadVersion: '3',
        messageId: 'm',
        correlationToken: 'c',
      },
      { endpointId: '5__dev' },
      { ctx, logger: quietLogger },
    )) as {
      event: { header: { name: string } }
      context: { properties: Array<{ value: unknown }> }
    }
    expect(lock).toHaveBeenCalledWith({ deviceId: 5 })
    expect(res.event.header.name).toBe('Response')
    expect(res.context.properties[0]?.value).toBe('LOCKED')
  })
})
