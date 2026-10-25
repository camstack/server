import { DEVICE_BACKEND_TO_FORMAT, type PipelineEngineChoice } from '@camstack/types'

/**
 * Resolve a Phase-1 device key (`<backend>:<device>`, or bare `cpu`) into the
 * {@link PipelineEngineChoice} used to build that device's inference pool.
 * Throws on an unknown backend token so a bad `deviceKey` fails loud rather
 * than silently building a wrong pool. Format comes from the shared
 * {@link DEVICE_BACKEND_TO_FORMAT} SSOT (`@camstack/types`) — no local copy.
 */
export function resolveDeviceEngine(deviceKey: string): PipelineEngineChoice {
  const colon = deviceKey.indexOf(':')
  const backend = colon >= 0 ? deviceKey.slice(0, colon) : deviceKey
  const device = colon >= 0 ? deviceKey.slice(colon + 1) : deviceKey
  const format = DEVICE_BACKEND_TO_FORMAT[backend]
  if (format === undefined) {
    throw new Error(`resolveDeviceEngine: unknown backend "${backend}" in deviceKey "${deviceKey}"`)
  }
  return { runtime: 'python', backend, format, device }
}

/**
 * The inverse of {@link resolveDeviceEngine}: the `<backend>:<device>` key that
 * names the pool an engine belongs to. Every pool-level log line carries this —
 * without it a default pool logs anonymously and six hours of logs cannot tell
 * "the NPU is unused" from "the NPU IS the anonymous default pool".
 * Falls back to the bare backend when the engine carries no device.
 */
export function deviceKeyOf(engine: PipelineEngineChoice): string {
  return engine.device ? `${engine.backend}:${engine.device}` : engine.backend
}
