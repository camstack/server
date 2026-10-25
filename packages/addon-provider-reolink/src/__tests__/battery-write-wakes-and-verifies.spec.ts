import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A settings WRITE is the one demand-side wake, and it verifies itself.
 *
 * ## What was measured, on device 3825, 2026-09-19
 *
 * The operator changed the OSD timestamp position. The write ran two seconds
 * after the camera announced it had gone to sleep. The Home Hub answered
 * success, `updateConfig` returned `{success: true}` in 0.8 s — and the camera
 * never held the value. The operator's report was "it has never moved, not
 * once", and this is why.
 *
 * Two independent faults produced that:
 *
 * 1. **The write never woke the camera.** On a hub child `ensureApi()` is the
 *    PARENT's socket, so nothing in the write path reaches the camera's radio.
 *    A battery camera is asleep at almost every save, so almost every save was
 *    a no-op.
 * 2. **The write said it had worked.** Nothing compared what we asked for with
 *    what the camera holds, so a lost write and an applied one were
 *    indistinguishable — to the code and to the operator.
 *
 * The post-write re-read could not have caught it either: it opens with
 * `if (isBattery && sleeping) return`, and it was consulting the very mirror
 * the write had just contradicted (logged `skipped — battery cam is sleeping`
 * at 12:49:32.683 and 12:51:02.777, both times right after a save).
 *
 * ## Why these assertions are structural
 *
 * Same reason as `battery-read-path-discipline.spec.ts`: constructing a real
 * `ReolinkCamera` means mocking the whole `DeviceContext`, while the invariant
 * is a property of the write path that must survive refactors of everything
 * around it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

function sliceMethodBody(source: string, methodSignature: string): string {
  const start = source.indexOf(methodSignature)
  if (start === -1) throw new Error(`method not found: ${methodSignature}`)
  let depth = 0
  let i = source.indexOf('{', start)
  if (i === -1) throw new Error(`opening brace not found for ${methodSignature}`)
  const bodyStart = i
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(bodyStart, i + 1)
    }
  }
  throw new Error(`unbalanced braces for ${methodSignature}`)
}

const applyBody = sliceMethodBody(
  cameraSource,
  'override async applySettingsPatch(patch: Record<string, unknown>): Promise<void>',
)
const refreshBody = sliceMethodBody(cameraSource, 'private async refreshParentSettingsSnapshot(')

describe('a settings write on a battery camera', () => {
  it('wakes the camera before writing camera-owned state', () => {
    // `wakeIfSleeping` is the operator-demand wake: it no-ops for a
    // non-battery or already-awake camera, so this costs nothing except on
    // the cameras where the write would otherwise be lost.
    expect(applyBody).toContain('wakeIfSleeping')
  })

  it('does not let the sleep mirror veto its own re-read', () => {
    // The write just used the socket. A mirror saying "asleep" is older
    // evidence than the write itself, and letting it decide is what served
    // the operator the pre-write snapshot.
    const gate = refreshBody.slice(refreshBody.indexOf('this.isBattery && this.sleeping'))
    expect(gate.slice(0, 120)).toContain('post-write')
  })

  it('asks for the post-write re-read with that reason', () => {
    const call = applyBody.slice(applyBody.indexOf('refreshParentSettingsSnapshot(changedSlices'))
    expect(call.slice(0, 200)).toContain("'post-write'")
  })

  it('refuses to report success for a write the camera did not take', () => {
    // A write that silently does nothing is worse than one that fails: with
    // the admin-UI in-flight overlay, a thrown error hands the operator their
    // edit back instead of quietly reverting it.
    expect(applyBody).toContain('assertOsdWriteLanded')
    const check = sliceMethodBody(
      cameraSource,
      'private assertOsdWriteLanded(patch: Record<string, unknown>): void',
    )
    expect(check).toContain('throw new Error')
    expect(check).toContain('the camera did not take')
    // Absence of a reading is not evidence of a lost write: a slice that
    // could not be re-read at all must pass, and the caller already reports
    // it as "snapshots left stale" (D393).
    expect(check).toContain("typeof got !== 'string'")
  })
})
