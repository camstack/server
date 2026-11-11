/**
 * Lists every fan preset as an `action-source` entry so the surfaces that
 * publish actions (a scene, a switch, a button — D968) offer "set the fan to
 * Night" without knowing what a fan preset is. The entry id is
 * `<addonId>:fan-preset:<deviceId>/<presetId>`; running it applies the preset
 * and FAILS the run when any step did not apply, naming the first one.
 */
import {
  type ActionEntry,
  type FanPresetApplyResult,
  IDLE_ACTION_STATUS,
  type IActionSourceProvider,
  type IFanPresetsProvider,
  type IScopedLogger,
} from '@camstack/types'
import type { FanPresetsDevices, FanPresetsStore } from './fan-presets-service.js'

const LOCAL_PREFIX = 'fan-preset:'

export interface FanPresetActionSourceDeps {
  readonly presets: Pick<IFanPresetsProvider, 'applyPreset'>
  readonly devices: Pick<FanPresetsDevices, 'describe'>
  readonly store: Pick<FanPresetsStore, 'listAll'>
  /** The addon that declares the entries (the id prefix). */
  readonly addonId: string
  readonly logger: IScopedLogger
}

interface ParsedPresetAction {
  readonly deviceId: number
  readonly presetId: string
}

export function fanPresetActionId(addonId: string, deviceId: number, presetId: string): string {
  return `${addonId}:${LOCAL_PREFIX}${deviceId}/${presetId}`
}

export function parseFanPresetActionId(
  addonId: string,
  actionId: string,
): ParsedPresetAction | null {
  const prefix = `${addonId}:${LOCAL_PREFIX}`
  if (!actionId.startsWith(prefix)) return null
  const rest = actionId.slice(prefix.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return null
  const deviceId = Number(rest.slice(0, slash))
  if (!Number.isInteger(deviceId) || deviceId < 0) return null
  return { deviceId, presetId: rest.slice(slash + 1) }
}

/** The first field that did not apply, as "oscillationAxes.horizontal.angle: …". */
function firstProblem(result: FanPresetApplyResult): string {
  const bad = result.fields.find((f) => f.outcome === 'failed' || f.outcome === 'refused')
  if (bad === undefined) return result.status === 'refused' ? 'the preset was not applied' : ''
  return `${bad.field}: ${bad.message ?? bad.outcome}`
}

export class FanPresetActionSource implements IActionSourceProvider {
  constructor(private readonly deps: FanPresetActionSourceDeps) {}

  async listActions(_input: Record<string, never>): Promise<ActionEntry[]> {
    const all = await this.deps.store.listAll()
    const entries: ActionEntry[] = []
    for (const [deviceId, presets] of all) {
      if (presets.length === 0) continue
      const facts = await this.deps.devices.describe(deviceId)
      if (facts === null) continue
      for (const preset of presets) {
        entries.push({
          id: fanPresetActionId(this.deps.addonId, deviceId, preset.id),
          name: `${facts.name}: ${preset.name}`,
          addonId: this.deps.addonId,
          source: 'addon',
          readOnly: true,
          status: IDLE_ACTION_STATUS,
        })
      }
    }
    return entries
  }

  async runAction(input: { actionId: string }): Promise<void> {
    const parsed = parseFanPresetActionId(this.deps.addonId, input.actionId)
    if (parsed === null) {
      throw new Error(`"${input.actionId}" is not a fan preset action`)
    }
    const result = await this.deps.presets.applyPreset(parsed)
    if (result.status === 'applied') return
    const problem = firstProblem(result)
    this.deps.logger.warn('fan preset action did not fully apply', {
      tags: { deviceId: parsed.deviceId },
      meta: { presetId: parsed.presetId, status: result.status, problem },
    })
    throw new Error(`fan preset ${result.status}: ${problem}`)
  }

  async stopAction(input: { actionId: string }): Promise<void> {
    this.deps.logger.debug('fan preset stop ignored — a preset is a few quick fan-control calls', {
      meta: { actionId: input.actionId },
    })
  }
}
