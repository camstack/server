import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * #666 — 2026-11-24 00:11:29, device 640: a "proactive action: waking sleeping
 * battery cam" fired 22 s after the camera fell asleep. The caller was the TAIL
 * of a scheduled settings refresh (`refreshParentSettingsSnapshot`): the refresh
 * had started while the camera was awake, the camera went back to sleep during
 * its ~40 s of reads, and the tail's email-config read then called
 * `wakeIfSleeping` — a wake for work the refresh was never entitled to.
 */

const camera = readFileSync(fileURLToPath(new URL('../reolink-camera.ts', import.meta.url)), 'utf8')

function methodBody(signature: string, until: string): string {
  const start = camera.indexOf(signature)
  expect(start, `${signature} exists`).toBeGreaterThanOrEqual(0)
  return camera.slice(start, camera.indexOf(until, start))
}

describe('the settings refresh tail never wakes the camera', () => {
  const tail = methodBody(
    'if (slices === undefined && this.isBattery && this.isEmailPushEligible)',
    'Admin-only raw-read debug surface',
  )

  it('reads the email config only while the camera is still awake, and says so when it skips', () => {
    expect(tail).toContain('this.sleeping')
    expect(tail).toContain('email config read skipped')
  })
})

describe('every wake names its caller', () => {
  it('wakeIfSleeping takes a caller and logs it under the device tag', () => {
    const body = methodBody(
      'private async wakeIfSleeping(',
      'Push the provider-level Email Push Server',
    )
    expect(body).toContain('caller: string')
    expect(body).toMatch(/waking sleeping battery cam[\s\S]*caller/)
  })

  it('no call site wakes anonymously', () => {
    const anonymous = camera.match(/this\.wakeIfSleeping\(\s*\)/g) ?? []
    expect(anonymous).toHaveLength(0)
  })
})
