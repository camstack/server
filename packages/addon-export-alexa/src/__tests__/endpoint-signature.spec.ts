/**
 * The signature is the ONLY thing that decides whether Alexa's cloud copy of
 * an endpoint is stale. These properties are what makes it safe to run the
 * reconcile on every bindings-change event without flooding the Event Gateway:
 * cosmetic churn must be invisible, and a gained/lost interface must never be.
 */
import { describe, it, expect } from 'vitest'
import { endpointsSignature } from '../endpoint-signature.js'
import type { AlexaCapability, AlexaEndpoint } from '../endpoints/types.js'

const BASE: AlexaCapability = { type: 'AlexaInterface', interface: 'Alexa', version: '3' }
const DOORBELL: AlexaCapability = {
  type: 'AlexaInterface',
  interface: 'Alexa.DoorbellEventSource',
  version: '3',
  proactivelyReported: true,
}
const CAMERA_STREAM: AlexaCapability = {
  type: 'AlexaInterface',
  interface: 'Alexa.CameraStreamController',
  version: '3',
  cameraStreamConfigurations: [
    {
      protocols: ['RTSP'],
      resolutions: [{ width: 1920, height: 1080 }],
      authorizationTypes: ['BASIC'],
      videoCodecs: ['H264'],
      audioCodecs: ['AAC'],
    },
  ],
}

function endpoint(patch: Partial<AlexaEndpoint> = {}): AlexaEndpoint {
  return {
    endpointId: '101',
    manufacturerName: 'camstack',
    description: 'CamStack camera',
    friendlyName: 'Camera front door',
    displayCategories: ['CAMERA'],
    capabilities: [BASE, CAMERA_STREAM],
    ...patch,
  }
}

describe('endpointsSignature', () => {
  it('CHANGES when the camera gains Alexa.DoorbellEventSource — the live 101 case', () => {
    const before = endpointsSignature([endpoint()])
    const after = endpointsSignature([
      endpoint({
        displayCategories: ['CAMERA', 'DOORBELL'],
        capabilities: [BASE, CAMERA_STREAM, DOORBELL],
      }),
    ])
    expect(after).not.toBe(before)
  })

  it('CHANGES when an interface is LOST', () => {
    const withDoorbell = endpointsSignature([
      endpoint({ capabilities: [BASE, CAMERA_STREAM, DOORBELL] }),
    ])
    const without = endpointsSignature([endpoint({ capabilities: [BASE, CAMERA_STREAM] })])
    expect(without).not.toBe(withDoorbell)
  })

  it('is stable across capability ORDER — a re-ordered build never re-pushes', () => {
    const a = endpointsSignature([endpoint({ capabilities: [BASE, CAMERA_STREAM, DOORBELL] })])
    const b = endpointsSignature([endpoint({ capabilities: [DOORBELL, CAMERA_STREAM, BASE] })])
    expect(b).toBe(a)
  })

  it('is stable across endpoint ORDER within a device', () => {
    const child = endpoint({ endpointId: '101__616', displayCategories: ['SWITCH'] })
    const a = endpointsSignature([endpoint(), child])
    const b = endpointsSignature([child, endpoint()])
    expect(b).toBe(a)
  })

  it('IGNORES a friendly-name edit — cosmetic churn must not hit the gateway', () => {
    const a = endpointsSignature([endpoint()])
    const b = endpointsSignature([endpoint({ friendlyName: 'Front door' })])
    expect(b).toBe(a)
  })

  it('DISTINGUISHES two instances of the same interface', () => {
    const panLeft: AlexaCapability = {
      type: 'AlexaInterface',
      interface: 'Alexa.ToggleController',
      version: '3',
      instance: 'Ptz.PanLeft',
    }
    const panRight: AlexaCapability = { ...panLeft, instance: 'Ptz.PanRight' }
    const a = endpointsSignature([endpoint({ capabilities: [BASE, panLeft] })])
    const b = endpointsSignature([endpoint({ capabilities: [BASE, panLeft, panRight] })])
    expect(b).not.toBe(a)
  })

  it('CHANGES when only the display category changes', () => {
    const a = endpointsSignature([endpoint()])
    const b = endpointsSignature([endpoint({ displayCategories: ['CAMERA', 'DOORBELL'] })])
    expect(b).not.toBe(a)
  })
})
