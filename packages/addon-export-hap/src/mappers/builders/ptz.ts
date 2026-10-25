/**
 * PTZ builder — surfaces a camstack PTZ camera's preset + continuous-
 * move surface AND its autotrack toggle as a fan of HomeKit switches.
 *
 * HomeKit has no first-class PTZ service, so we lean on the established
 * Homebridge pattern: one `Service.Switch` per discrete action, momentary
 * (auto-reset to OFF) for impulse commands. Apple
 * Home renders the switches as toggles inside the accessory.
 *
 * Services added (each gated on a runtime probe — none are added when
 * the camera advertises neither preset nor continuous-move):
 *  - One momentary switch per preset returned by
 *    `proxy.ptz.getPresets({})`. Toggling ON calls
 *    `proxy.ptz.goToPreset({presetId})` and auto-resets to OFF after 1s.
 *  - Four directional momentary switches ("Pan Left", "Pan Right",
 *    "Tilt Up", "Tilt Down") that issue ONE `ptz.move` — the PTZ cap's
 *    self-terminating burst, whose duration the DRIVER owns and reports as
 *    `getOptions().moveImpulseMs` (ptz.cap.ts). The exporter carries no
 *    duration of its own. Auto-reset to OFF once the pulse is over.
 *  - One stateful switch "Autotrack" when the proxy has the
 *    `ptz-autotrack` cap bound. Toggling sets
 *    `proxy.ptzAutotrack.setEnabled({enabled})`. Initial value is
 *    hydrated from `getStatus({})`.
 *
 * Naming: the bare action — "Preset stanza", "Pan Left", "Autotrack" — built
 * by `ptzServiceName` and published through `applyServiceLabel`, which writes
 * it to BOTH `Name` and `ConfiguredName`. The camera name is deliberately not
 * prefixed — these eight services live on that camera's accessory and iOS
 * shows them there. THREE rounds of this bug have been through this file;
 * `service-label.ts` records what each got wrong, and why only the writable
 * characteristic can rename a service after pairing.
 */
import { Characteristic, Service } from '@homebridge/hap-nodejs'

import type { BuilderContext, BuilderHandle } from '../types.js'
import { PTZ_AUTOTRACK_LABEL, PTZ_DIRECTIONS, ptzPresetLabel } from './ptz-labels.js'
import { applyServiceLabel } from './service-label.js'
import { ptzServiceName } from './service-names.js'

const MOMENTARY_RESET_MS = 1_000

interface PresetEntry {
  readonly id: string
  readonly name: string
}

interface AutotrackStatusLike {
  readonly enabled?: boolean
}

export async function buildPtz(bctx: BuilderContext): Promise<BuilderHandle> {
  const { ctx, accessory, proxy, numericDeviceId } = bctx
  const log = ctx.logger.withTags({ deviceId: numericDeviceId })
  const timers = new Set<NodeJS.Timeout>()

  const armReset = (cb: () => void, delay: number): void => {
    const t = setTimeout(() => {
      timers.delete(t)
      cb()
    }, delay)
    timers.add(t)
  }

  // ── Presets ────────────────────────────────────────────────────────
  const presets = await readPresets(bctx)
  for (const preset of presets) {
    const label = ptzServiceName(ptzPresetLabel(preset.name))
    const subtype = `ptz-preset-${preset.id}`
    const service = accessory.addService(Service.Switch, label, subtype)
    applyServiceLabel(service, label)
    service.getCharacteristic(Characteristic.On).onSet(async (value) => {
      if (value !== true) return
      try {
        await proxy.ptz?.goToPreset({ presetId: preset.id })
      } catch (err) {
        log.warn('export-hap: ptz.goToPreset failed', {
          meta: { presetId: preset.id, error: errMsg(err) },
        })
      }
      armReset(() => service.updateCharacteristic(Characteristic.On, false), MOMENTARY_RESET_MS)
    })
  }

  // ── Directional momentary switches ─────────────────────────────────
  // We only register them when the device advertises PTZ — presence of
  // the `ptz` binding entry is the signal. Each press is ONE `ptz.move`:
  // the driver runs it for the pulse it calibrated and stops the head
  // itself, so no `continuousMove` + timer + `stop` is ours to drive.
  if (proxy.ptz) {
    const impulse = createImpulseReader(bctx)
    for (const dir of PTZ_DIRECTIONS) {
      const label = ptzServiceName(dir.label)
      const service = accessory.addService(Service.Switch, label, dir.subtype)
      applyServiceLabel(service, label)
      // The reset always goes through a timer: hap-nodejs assigns the written
      // value AFTER the set handler resolves, so an `updateCharacteristic(false)`
      // issued inside the handler is overwritten by the `true` being written.
      const reset = (delayMs: number): void =>
        armReset(() => service.updateCharacteristic(Characteristic.On, false), delayMs)
      service.getCharacteristic(Characteristic.On).onSet(async (value) => {
        if (value !== true) return
        const startedAt = Date.now()
        try {
          await proxy.ptz?.move({ ...dir.cmd })
        } catch (err) {
          log.warn('export-hap: ptz.move failed', {
            meta: { dir: dir.label, error: errMsg(err) },
          })
          reset(0)
          return
        }
        reset(remainingPulseMs(await impulse.read(), Date.now() - startedAt))
      })
    }
  }

  // ── Autotrack toggle ───────────────────────────────────────────────
  const autotrackHandle = await tryBuildAutotrack(bctx)

  return {
    async dispose(): Promise<void> {
      for (const t of timers) clearTimeout(t)
      timers.clear()
      await autotrackHandle.dispose()
    },
  }
}

async function readPresets(bctx: BuilderContext): Promise<readonly PresetEntry[]> {
  const { ctx, proxy, numericDeviceId } = bctx
  try {
    const raw = await proxy.ptz?.getPresets({})
    if (!Array.isArray(raw)) return []
    const entries: PresetEntry[] = []
    for (const p of raw) {
      if (typeof p !== 'object' || p === null) continue
      const candidate = p as { id?: unknown; name?: unknown; fn?: unknown }
      if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') continue
      // A reserved id is a firmware FUNCTION sharing the preset namespace, and
      // every preset here becomes a HomeKit SWITCH anyone in the home can flip.
      // The dispensa camera advertises `94 Remote reboot` and `95 Call OSD
      // menu` among its presets -- exposing those to Siri and to automations
      // was never intended. Stored positions pass, and so does `home`, which is
      // the one function worth a button.
      const fn = candidate.fn
      if (fn !== null && fn !== undefined && fn !== 'home') continue
      entries.push({ id: candidate.id, name: candidate.name })
    }
    return entries
  } catch (err) {
    ctx.logger
      .withTags({ deviceId: numericDeviceId })
      .debug('export-hap: ptz.getPresets failed (non-fatal)', { meta: { error: errMsg(err) } })
    return []
  }
}

async function tryBuildAutotrack(bctx: BuilderContext): Promise<BuilderHandle> {
  const { ctx, accessory, proxy, numericDeviceId } = bctx
  if (!proxy.ptzAutotrack) {
    return {
      async dispose() {
        /* nothing */
      },
    }
  }

  const log = ctx.logger.withTags({ deviceId: numericDeviceId })
  const label = ptzServiceName(PTZ_AUTOTRACK_LABEL)
  const service = accessory.addService(Service.Switch, label, 'ptz-autotrack')
  applyServiceLabel(service, label)

  try {
    const status = (await proxy.ptzAutotrack.getStatus({})) as AutotrackStatusLike | null
    if (status && typeof status.enabled === 'boolean') {
      service.updateCharacteristic(Characteristic.On, status.enabled)
    }
  } catch (err) {
    log.debug('export-hap: ptzAutotrack.getStatus failed (non-fatal)', {
      meta: { error: errMsg(err) },
    })
  }

  service.getCharacteristic(Characteristic.On).onSet(async (value) => {
    const enabled = value === true
    try {
      await proxy.ptzAutotrack?.setEnabled({ enabled })
    } catch (err) {
      log.warn('export-hap: ptzAutotrack.setEnabled failed', {
        meta: { enabled, error: errMsg(err) },
      })
    }
  })

  return {
    async dispose(): Promise<void> {
      // Service removal is handled by the orchestrator when the parent
      // accessory is removed from the bridge. Nothing to undo here.
    },
  }
}

/**
 * How long the switch should still read ON after `move` resolved.
 *
 * Drivers differ in WHEN `move` returns: hikvision awaits its own pulse before
 * resolving, while reolink (`autoStopMs`), amcrest (background stop) and onvif
 * (`timeout`) return as soon as the burst has started. Subtracting the time the
 * call took covers both: the switch stays ON for the pulse, never longer. An
 * unknown impulse (`null`) resets at once — the head still stops on its own.
 */
export function remainingPulseMs(moveImpulseMs: number | null, elapsedMs: number): number {
  if (moveImpulseMs === null) return 0
  return Math.max(0, moveImpulseMs - elapsedMs)
}

interface ImpulseReader {
  read(): Promise<number | null>
}

/**
 * Reads `ptz.getOptions().moveImpulseMs` once and keeps it. A failed or
 * unreported read is NOT cached, so a camera that was offline at the first
 * press answers on a later one.
 */
function createImpulseReader(bctx: BuilderContext): ImpulseReader {
  const { ctx, proxy, numericDeviceId } = bctx
  let known: number | null = null
  return {
    async read(): Promise<number | null> {
      if (known !== null) return known
      try {
        const options = await proxy.ptz?.getOptions({})
        const ms = options?.moveImpulseMs
        known = typeof ms === 'number' && ms > 0 ? ms : null
      } catch (err) {
        ctx.logger
          .withTags({ deviceId: numericDeviceId })
          .debug('export-hap: ptz.getOptions failed (non-fatal)', { meta: { error: errMsg(err) } })
      }
      return known
    },
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
