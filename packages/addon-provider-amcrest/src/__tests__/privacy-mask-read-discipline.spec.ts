import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * What one open admin page costs THESE cameras.
 *
 * `pipelineOrchestrator.getCameraStatuses` composes the switched-off badge for
 * every camera and the admin page polls it every 5 seconds; the only authority
 * behind that badge that leaves the server is `privacy-mask`
 * ([D221](../../../../docs/decisions/adr-0221-a-polled-list-never-dials-a-camera.md)).
 *
 * One camera on the current fleet, and the same rule: the discipline is a
 * property of the CAP on a polled path, not of how many devices happen to use
 * this provider today.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../amcrest-camera.ts'), 'utf8')

/** The body of `registerPrivacyMaskCap`, brace-matched. */
function privacyMaskCapBody(): string {
  const signature = 'private registerPrivacyMaskCap('
  const start = cameraSource.indexOf(signature)
  if (start === -1) throw new Error('registerPrivacyMaskCap not found')
  let depth = 0
  let i = cameraSource.indexOf('{', cameraSource.indexOf(')', start))
  const bodyStart = i
  for (; i < cameraSource.length; i += 1) {
    const ch = cameraSource[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return cameraSource.slice(bodyStart, i + 1)
    }
  }
  throw new Error('registerPrivacyMaskCap body not closed')
}

describe('amcrest privacy-mask — the read discipline a polled badge needs', () => {
  const body = privacyMaskCapBody()

  it('gives the status bridge the operator-written window, not the 10s default', () => {
    expect(body).toMatch(/staleMs:\s*OPERATOR_WRITTEN_STALE_MS/)
    expect(body).not.toMatch(/staleMs:\s*STALE_MS/)
  })

  it('serves a stale read and revalidates behind it, so no poll waits on the camera', () => {
    expect(body).toMatch(/staleRead:\s*'serve-and-revalidate'/)
  })

  it('re-reads the camera after a write, which is what makes the window safe', () => {
    const setMask = body.slice(body.indexOf('setMask: async'))
    expect(setMask).toMatch(/refreshFromCamera\(\)/)
  })
})
