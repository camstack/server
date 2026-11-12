/**
 * Renaming a device on ONE Alexa skill (D1049, `device-export.setExposedName`).
 *
 * The name is saved under the skill's instance id in the addon's per-device store (every skill
 * of the addon shares that store, each under its own key). A name Amazon would refuse throws
 * `ExportNameRefusedError` before anything is written; a dry run refuses the same way and writes
 * nothing. An exposed device is pushed again: the endpoint id never sees the name, so the
 * AddOrUpdateReport renames the SAME Alexa device (the shape signature ignores names, so the
 * reconcile alone would never send it).
 *
 * The store read must THROW when it cannot answer: a read that answered `{}` would rebuild the
 * names blob without the other skills' names and erase them.
 */
import type { ExposedNameStore, IScopedLogger } from '@camstack/types'
import { saveExposedName } from '@camstack/types'
import { alexaNameValidator } from './endpoints/alexa-name.js'

export interface SkillRenameDeps {
  readonly instanceId: string
  readonly store: ExposedNameStore
  readonly logger: IScopedLogger
  isExposed(deviceId: number): boolean
  /** Push the device to every linked account of this skill (AddOrUpdateReport). */
  push(deviceId: number): Promise<unknown>
}

export interface SkillRenameOptions {
  readonly dryRun?: boolean
}

export async function renameOnSkill(
  deps: SkillRenameDeps,
  deviceIdRaw: string,
  raw: unknown,
  options: SkillRenameOptions = {},
): Promise<void> {
  const deviceId = Number.parseInt(deviceIdRaw, 10)
  if (!Number.isFinite(deviceId)) {
    throw new Error(`export-alexa: deviceId must be numeric — got "${deviceIdRaw}"`)
  }
  const saved = await saveExposedName({
    store: deps.store,
    deviceId,
    instanceId: deps.instanceId,
    raw,
    validate: alexaNameValidator,
    ...(options.dryRun === true ? { dryRun: true } : {}),
  })
  if (!saved.changed) return
  deps.logger.info('export-alexa: Alexa name saved', {
    tags: { deviceId },
    meta: { instanceId: deps.instanceId, name: saved.name },
  })
  if (!deps.isExposed(deviceId)) return
  void deps.push(deviceId).catch((err: unknown) => {
    deps.logger.warn('export-alexa: push after an Alexa name change failed', {
      tags: { deviceId },
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
  })
}
