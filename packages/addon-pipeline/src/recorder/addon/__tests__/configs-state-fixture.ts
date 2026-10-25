/**
 * The recording-config handle the recorder specs run against — over the
 * STANDARD per-device settings (D865), faked as an in-memory map with the same
 * semantics as `ctx.settings.*DeviceStore`.
 *
 * A spec that hands the provider an object shaped like the store rather than
 * the store is free to answer a call production never makes, and to miss one it
 * does. The fake keeps the surface to exactly what the handle calls.
 */
import type { IScopedLogger } from '@camstack/types'
import {
  recordingConfigsState,
  type DeviceConfigSettings,
  type RecordingConfigsState,
} from '../config-store.js'

function silentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger }
  // Documented type boundary: the store only ever calls `warn` / `info`.
  return logger as unknown as IScopedLogger
}

/** `ctx.settings`' per-device store, in memory; `calls` records every call. */
export interface FakeDeviceSettings extends DeviceConfigSettings {
  readonly rows: Map<number, Record<string, unknown>>
  readonly calls: string[]
}

export function makeDeviceSettingsFake(): FakeDeviceSettings {
  const rows = new Map<number, Record<string, unknown>>()
  const calls: string[] = []
  return {
    rows,
    calls,
    readDeviceStore: async (id) => {
      calls.push(`read:${id}`)
      return { ...rows.get(id) }
    },
    writeDeviceStore: async (id, patch) => {
      calls.push(`write:${id}`)
      const next: Record<string, unknown> = { ...rows.get(id), ...patch }
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
      if (Object.keys(next).length === 0) rows.delete(id)
      else rows.set(id, next)
    },
    readDeviceStoreBatch: async (ids) => {
      calls.push('batch')
      return new Map(ids.map((id) => [id, { ...rows.get(id) }]))
    },
    listDeviceStoreIds: async () => {
      calls.push('list')
      return [...rows.keys()].toSorted((a, b) => a - b)
    },
  }
}

/** An empty handle over fresh per-device settings. */
export async function makeConfigsState(): Promise<RecordingConfigsState> {
  const state = recordingConfigsState({
    settings: makeDeviceSettingsFake(),
    logger: silentLogger(),
  })
  await state.declare()
  return state
}
