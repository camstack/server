import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * "Refresh from camera" is the operator's way to force the truth.
 *
 * Every READ this provider performs is deliberately cheap about the camera's
 * battery: a stale slice is served as-is and revalidated behind the answer,
 * and on a sleeping camera the revalidation does nothing at all. That is
 * right — waking a camera because somebody opened a settings tab is the
 * defect the sleep gates exist for, and it kept a doorbell awake for as long
 * as its tab was open.
 *
 * The cost of that choice is that a camera can be believed for a long time on
 * evidence nobody refreshed. The answer is not a shorter window — it is a
 * button: one place where the operator says "go and ask it now", and the
 * system wakes the camera, re-reads everything, and REPORTS what it got.
 *
 * Measured on 3825 on 2026-09-19, this button did none of those three things:
 * `refreshParentSettingsSnapshot()` opens with the sleep gate and declined,
 * only the `stream-params` slice was warmed of the six the form reads, and the
 * action returned `void` whether it had refreshed everything or nothing.
 *
 * Structural, for the reason the sibling battery specs give: building a real
 * `ReolinkCamera` means mocking the whole `DeviceContext`, while what matters
 * here is a property of the action's wiring.
 */

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

function actionBody(name: string): string {
  const at = source.indexOf(`this.registerDeviceAction(\n      '${name}'`)
  if (at === -1) throw new Error(`device action not found: ${name}`)
  // Up to the next registration, which is the end of this handler.
  const next = source.indexOf('this.registerDeviceAction(', at + 10)
  return source.slice(at, next === -1 ? at + 4000 : next)
}

describe('the refresh-settings button', () => {
  const body = actionBody('refresh-settings')

  it('wakes the camera — it is an operator demand, not a background probe', () => {
    expect(body).toContain('wakeIfSleeping')
  })

  it('re-reads everything without asking the sleep mirror for permission', () => {
    // The mirror is what the wake just contradicted. Passing the reason is
    // what separates this from the background refresh that correctly declines.
    expect(body).toContain("'operator'")
  })

  it('warms every cap slice, not just the one the Stream section reads', () => {
    expect(body).toContain('warmCapSlicesOnWake')
  })

  it('reports what it got, because a rehydrate that silently declines is the defect', () => {
    expect(body).toMatch(/return\s*\{/)
    expect(body).toContain('awake')
  })
})

describe('warmCapSlicesOnWake', () => {
  it('can be forced past its freshness skip', () => {
    // On a wake it skips slices younger than WAKE_WARM_MAX_AGE_MS, which is
    // right for an automatic warm and wrong for a button whose entire purpose
    // is to distrust what we already believe.
    const at = source.indexOf('private async warmCapSlicesOnWake(')
    expect(at).toBeGreaterThan(-1)
    expect(source.slice(at, at + 400)).toContain('force')
  })
})
