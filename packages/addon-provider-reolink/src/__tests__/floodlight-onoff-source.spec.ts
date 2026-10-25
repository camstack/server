import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Floodlight on/off must come from the cmd-291 FloodlightStatusList push
 * (`getCachedFloodlightStatus().value.status` = "currently emitting light"),
 * NOT from `getWhiteLedState().enabled`.
 *
 * Why: `WhiteLedState.enabled` is the white-LED/status-indicator LED — and the
 * library doc warns doorbells return `<WhiteLed>` for their status LED, which
 * is NOT a floodlight. So on a doorbell (device 8) `enabled` reads stuck-true,
 * showing a phantom "floodlight on". `floodlight.on` must come from the
 * cached floodlight status, with `getWhiteLedState` used only for brightness.
 */
const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(resolve(here, '../accessories/floodlight.ts'), 'utf8')

function body(sig: string): string {
  const start = src.indexOf(sig)
  if (start === -1) throw new Error(`not found: ${sig}`)
  let i = src.indexOf('{', start)
  const s = i
  let d = 0
  for (; i < src.length; i += 1) {
    const c = src[i]
    if (c === '{') d += 1
    else if (c === '}') {
      d -= 1
      if (d === 0) return src.slice(s, i + 1)
    }
  }
  throw new Error(`unterminated: ${sig}`)
}

describe('floodlight on/off source', () => {
  const refresh = body('private async refreshLightFromFirmware(')

  it('derives on/off from getCachedFloodlightStatus (cmd 291 status), not getWhiteLedState().enabled', () => {
    expect(refresh).toMatch(/getCachedFloodlightStatus/)
    // The on-state must NOT be `Boolean(state?.enabled)` from getWhiteLedState.
    expect(refresh).not.toMatch(/on\s*=\s*Boolean\(state\?\.enabled\)/)
  })

  it('still reads brightness from getWhiteLedState', () => {
    expect(refresh).toMatch(/getWhiteLedState/)
    expect(refresh).toMatch(/state\?\.brightness/)
  })

  it('only writes the switch slice when a floodlight status is actually present', () => {
    // Absent cached status (e.g. doorbell status-LED-only) must NOT force a
    // phantom on/off — guard the setCapSlice(switch...) on the cached value.
    const cachedIdx = refresh.indexOf('getCachedFloodlightStatus')
    const switchWriteIdx = refresh.indexOf('setCapSlice(switchCapability')
    expect(cachedIdx).toBeGreaterThan(-1)
    expect(switchWriteIdx).toBeGreaterThan(cachedIdx)
  })
})
