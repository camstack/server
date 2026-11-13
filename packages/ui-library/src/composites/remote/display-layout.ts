/**
 * Which layout a remote is drawn with. A saved template wins. With none, the
 * built-in preset that covers the most of the device's roles — the same
 * starting layouts the layout editor offers — so a key is never a raw id.
 */
import type { RemoteLayoutPayload } from '@camstack/types'
import { REMOTE_LAYOUT_PRESETS } from './layout-presets'

export function layoutForRemoteCommands(
  saved: RemoteLayoutPayload | null,
  roles: readonly string[],
): RemoteLayoutPayload | null {
  if (saved !== null && saved.buttons.length > 0) return saved
  if (roles.length === 0) return null
  const first = REMOTE_LAYOUT_PRESETS[0]
  if (first === undefined) return null
  let best: RemoteLayoutPayload = first.layout
  let bestScore = -1
  for (const preset of REMOTE_LAYOUT_PRESETS) {
    const have = new Set(preset.layout.buttons.map((button) => button.role))
    let score = 0
    for (const role of roles) if (have.has(role)) score += 1
    if (score > bestScore) {
      best = preset.layout
      bestScore = score
    }
  }
  return best
}
