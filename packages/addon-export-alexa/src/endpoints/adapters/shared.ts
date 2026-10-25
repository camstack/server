import type { AlexaCapability } from '../types.js'
import type { GenericProperty, PropertyShaping } from './types.js'

/** The base `Alexa` interface every endpoint declares. */
export const BASE: AlexaCapability = { type: 'AlexaInterface', interface: 'Alexa', version: '3' }

/** `Alexa.EndpointHealth`, closing every generic endpoint (D770). */
export const HEALTH: AlexaCapability = {
  type: 'AlexaInterface',
  interface: 'Alexa.EndpointHealth',
  version: '3.1',
  properties: {
    supported: [{ name: 'connectivity' }],
    proactivelyReported: true,
    retrievable: true,
  },
}

/** A non-instanced interface with one retrievable, proactively reported property. */
export function iface(name: string, property: string): AlexaCapability {
  return {
    type: 'AlexaInterface',
    interface: name,
    version: '3',
    properties: {
      supported: [{ name: property }],
      proactivelyReported: true,
      retrievable: true,
    },
  }
}

/** Amazon's `detectionState` value for a boolean. */
export function detectionValue(detected: boolean): 'DETECTED' | 'NOT_DETECTED' {
  return detected ? 'DETECTED' : 'NOT_DETECTED'
}

/** The shaping of an adapter whose properties are reported on every change. */
export function unshaped(_property: GenericProperty): PropertyShaping | null {
  return null
}

/** The number a plain numeric property carries, or null. */
export function plainNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

/** The `.value` of an `{ value: number }` object property, or null. */
export function numericValueField(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null
  const raw: unknown = Reflect.get(value, 'value')
  return typeof raw === 'number' ? raw : null
}
