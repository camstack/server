import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The device Config tab must never WAIT on a camera.
 *
 * `deviceManager.getDeviceAggregate` calls `getOptions` + `getStatus` on every
 * bound device-config cap, the Admin UI re-polls it every 2.5 s while the tab
 * is open, and — unlike the other contributions — the derived-form ones carry
 * no deadline. So whatever a status bridge does, the tab does too.
 *
 * Five bridges shipped with `staleMs: 10_000` and the DEFAULT `await-refresh`
 * policy. Ten seconds after any open, the next poll dialled the camera and the
 * tab sat on "Loading device aggregate…" until the camera answered. On a
 * sleeping battery camera behind an NVR that is not seconds:
 *
 *   2026-09-19, device 3825 — the tab hung until the camera was woken by
 *   something else entirely; once awake it "unblocked after several seconds".
 *
 * `privacy-mask` already had the answer (D224): a window that bounds only a
 * change made in the REOLINK APP — because a CamStack write re-reads the
 * camera itself and is its own invalidation — plus `serve-and-revalidate`, so
 * the known state is served immediately and the refresh happens behind the
 * form. These five ask exactly the same question and get the same discipline.
 *
 * Structural, for the reason `battery-read-path-discipline.spec.ts` gives:
 * building a real `ReolinkCamera` means mocking the whole `DeviceContext`,
 * while the invariant is a property of how these bridges are DECLARED.
 */

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

/** The derived-form caps the Config tab renders, by their registrar. */
const DERIVED_FORM_CAPS = [
  'registerStreamParamsCap',
  'registerMotionZonesCap',
  'registerDayNightCap',
  'registerImageSettingsCap',
  'registerPtzAutotrackIfSupported',
] as const

function registrarBody(name: string): string {
  const start = source.indexOf(`private ${name}(`)
  if (start === -1) throw new Error(`registrar not found: ${name}`)
  let depth = 0
  let i = source.indexOf('{', start)
  const from = i
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(from, i + 1)
    }
  }
  throw new Error(`unbalanced braces: ${name}`)
}

describe('every derived-form cap is read off the mirror, never off the camera', () => {
  for (const registrar of DERIVED_FORM_CAPS) {
    it(`${registrar} serves and revalidates`, () => {
      const body = registrarBody(registrar)
      expect(body).toContain("staleRead: 'serve-and-revalidate'")
    })

    it(`${registrar} bounds only a change made in the Reolink app`, () => {
      const body = registrarBody(registrar)
      // Not a 10 s poll window: these values change when an operator changes
      // them, and a CamStack write re-reads the camera on its own.
      expect(body).toContain('staleMs: OPERATOR_WRITTEN_STALE_MS')
      expect(body).not.toContain('staleMs: STALE_MS')
    })
  }
})
