import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Regression guard for the "Reolink intercom closes immediately" bug.
 *
 * ROOT CAUSE
 * ----------
 * `registerIntercomIfSupported()` reads the `hasIntercom` flag from the
 * `feature-probe` runtime-state slice. That slice is EMPTY at construction
 * time (the constructor calls `registerNativeCapabilities()` synchronously,
 * but the probe runs later in the kernel-driven `onProbe()` lifecycle hook).
 * So on a fresh boot the synchronous registration pass returns early and the
 * `intercom` cap is never registered.
 *
 * Its sibling probe-gated caps (PTZ, PTZ-autotrack, doorbell) handle this by
 * being RE-registered retroactively at the end of `probeAndPersistFeatures()`,
 * once the flags are known. Intercom was missing from that retroactive block.
 *
 * SYMPTOM
 * -------
 * The UI's two-way-audio button calls `intercom.startSession`, the cap router
 * finds no provider bound to the device, the call fails at the routing layer
 * BEFORE any orchestrator/talk-session code runs (hence ZERO intercom logs for
 * the device), and the intercom panel closes immediately.
 *
 * THE FIX
 * -------
 * Add `this.registerIntercomIfSupported()` to the retroactive-registration
 * block. The helper is already idempotent (guards on `this.intercomRegistered`)
 * exactly like its PTZ/autotrack/doorbell siblings, so a retroactive call after
 * a no-op synchronous call is safe.
 *
 * WHY A SOURCE-STRUCTURE TEST
 * ---------------------------
 * Constructing the full `ReolinkCamera` requires mocking the entire
 * `DeviceContext` (runtime-state, config, devices, logger, Baichuan API) — the
 * existing camera specs deliberately avoid that and test gate logic structurally
 * instead (see `native-object-detection.spec.ts`). The bug is purely a missing
 * retroactive registration call; a structural assertion on the source encodes
 * the parity invariant that was violated and is resilient to refactors of the
 * helpers themselves.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

/**
 * Extract the body of `probeAndPersistFeatures` from `registerNativeCapabilities`
 * down to the "probed + persisted" log line — the span that contains the
 * retroactive-registration calls.
 */
function retroactiveRegistrationBlock(source: string): string {
  const start = source.indexOf('Now that features are known, register optional caps retroactively')
  if (start === -1) {
    throw new Error('retroactive-registration block marker not found in reolink-camera.ts')
  }
  const end = source.indexOf('Reolink features probed + persisted', start)
  if (end === -1) {
    throw new Error('"probed + persisted" log marker not found after retroactive block')
  }
  return source.slice(start, end)
}

describe('Reolink intercom: retroactive registration after feature probe', () => {
  const block = retroactiveRegistrationBlock(cameraSource)

  it('re-registers PTZ retroactively (baseline sibling — proves the pattern exists)', () => {
    expect(block).toContain('this.registerPtzIfSupported()')
  })

  it('re-registers PTZ-autotrack retroactively (baseline sibling)', () => {
    expect(block).toContain('this.registerPtzAutotrackIfSupported()')
  })

  it('re-registers doorbell retroactively (baseline sibling)', () => {
    expect(block).toContain('this.registerDoorbellIfSupported()')
  })

  it('re-registers intercom retroactively (THE FIX — was missing, caused immediate close)', () => {
    expect(block).toContain('this.registerIntercomIfSupported()')
  })
})

describe('Reolink intercom: registration helper is idempotent (safe to call twice)', () => {
  it('guards on this.intercomRegistered before doing work', () => {
    // The retroactive call must be a no-op when the synchronous pass already
    // registered the cap (probe slice was warm from a prior boot's rehydrate).
    const helper = cameraSource.slice(
      cameraSource.indexOf('private registerIntercomIfSupported(): void {'),
    )
    const firstStatement = helper.slice(0, helper.indexOf('\n', helper.indexOf('{') + 1) + 200)
    expect(firstStatement).toContain('if (this.intercomRegistered) return')
  })
})
