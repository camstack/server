/**
 * Test doubles.
 *
 * Both are real implementations of the interfaces, not casts: `DeviceGateway`
 * exists precisely so the intent handlers can be exercised without a tRPC
 * client, and `RecordingLogger` implements `IScopedLogger` so the tests can
 * assert on the lines a DROP branch is required to emit.
 */
import type { IScopedLogger, LogExtras } from '@camstack/types'

import type { DeviceGateway } from '../device-gateway.js'
import type { ExportableDeviceFacts } from '../google-home/device-model.js'
import type { CapCall, CapStatusRead } from '../google-home/trait-catalog.js'

export interface RecordedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras?: LogExtras
}

export class RecordingLogger implements IScopedLogger {
  readonly lines: RecordedLine[] = []

  debug(message: string, extras?: LogExtras): void {
    this.lines.push({ level: 'debug', message, extras })
  }
  info(message: string, extras?: LogExtras): void {
    this.lines.push({ level: 'info', message, extras })
  }
  warn(message: string, extras?: LogExtras): void {
    this.lines.push({ level: 'warn', message, extras })
  }
  error(message: string, extras?: LogExtras): void {
    this.lines.push({ level: 'error', message, extras })
  }
  child(): IScopedLogger {
    return this
  }
  withTags(): IScopedLogger {
    return this
  }

  /** Lines whose `tags.deviceId` is exactly `deviceId`. */
  taggedWith(deviceId: number): readonly RecordedLine[] {
    return this.lines.filter((line) => line.extras?.tags?.deviceId === deviceId)
  }
}

export interface FakeGatewayOptions {
  readonly devices?: Readonly<Record<number, ExportableDeviceFacts>>
  readonly statuses?: Readonly<Record<string, unknown>>
  /** Device ids whose `loadFacts` should reject rather than return null. */
  readonly failingFacts?: readonly number[]
  /** Cap-call kinds whose dispatch should reject. */
  readonly failingCalls?: readonly string[]
}

export interface FakeGateway extends DeviceGateway {
  readonly dispatched: CapCall[]
}

/** Key for the `statuses` map: one status per (cap, device). */
export function statusKey(read: CapStatusRead, deviceId: number): string {
  return `${read}:${deviceId}`
}

export function createFakeGateway(options: FakeGatewayOptions = {}): FakeGateway {
  const devices = options.devices ?? {}
  const statuses = options.statuses ?? {}
  const failingFacts = options.failingFacts ?? []
  const failingCalls = options.failingCalls ?? []
  const dispatched: CapCall[] = []

  return {
    dispatched,
    loadFacts: async (deviceId) => {
      if (failingFacts.includes(deviceId)) throw new Error(`registry down for ${deviceId}`)
      return devices[deviceId] ?? null
    },
    readStatus: async (read, deviceId) => statuses[statusKey(read, deviceId)] ?? null,
    dispatch: async (call) => {
      if (failingCalls.includes(call.kind)) throw new Error(`provider refused ${call.kind}`)
      dispatched.push(call)
    },
  }
}

export function facts(overrides: Partial<ExportableDeviceFacts> = {}): ExportableDeviceFacts {
  return {
    deviceId: 1,
    name: 'Device',
    deviceType: 'switch',
    features: [],
    capNames: ['switch'],
    ...overrides,
  }
}
