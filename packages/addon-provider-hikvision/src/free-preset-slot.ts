/**
 * The lowest preset id this camera will actually accept a write on.
 *
 * "Set home here" has to land somewhere, and on a camera whose home IS a preset
 * that means claiming a slot. Two things make the choice non-obvious:
 *
 *  - the reserved FUNCTION band shares the preset namespace (34 "Back to
 *    origin", 94 "Remote reboot", 95 "Call OSD menu" and friends), and writing
 *    one answers HTTP 500;
 *  - the operator's own presets must not be overwritten, ever. Losing
 *    "Credenza" to make room for a home is a worse trade than refusing.
 *
 * So: the first id that is neither taken nor reserved, within the camera's
 * advertised budget. `null` when there is no room, and the caller must then
 * REFUSE rather than pick a victim.
 */
import { isPresetWritable } from './ptz-preset-functions.js'

export interface PresetSlotCandidate {
  readonly id: string
  readonly writable: boolean
}

export function findFreePresetSlot(
  taken: readonly PresetSlotCandidate[],
  maxPresets: number | undefined,
): string | null {
  const used = new Set(taken.map((p) => p.id))
  // Without an advertised budget, stay inside the band below the reserved one
  // rather than inventing a ceiling the firmware never mentioned.
  const ceiling = maxPresets === undefined ? 32 : Math.min(maxPresets, 300)
  for (let id = 1; id <= ceiling; id += 1) {
    const candidate = String(id)
    if (used.has(candidate)) continue
    if (!isPresetWritable(candidate)) continue
    return candidate
  }
  return null
}

/**
 * The name written on a preset claimed by "set home here".
 *
 * Named rather than left a literal so the slot is recognisable in the camera's
 * own web UI — an operator who finds an unexplained preset has no way to know
 * it is ours.
 */
export const HOME_PRESET_NAME = 'CamStack Home'
