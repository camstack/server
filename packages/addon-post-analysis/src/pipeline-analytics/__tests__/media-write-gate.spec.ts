import { describe, expect, it } from 'vitest'
import { callDeferredRelease } from '../../__tests__/support/vitest-mock.js'
import { MediaWriteGate } from '../media-write-gate.js'

describe('MediaWriteGate', () => {
  it('drains an admitted write and rejects new writes until resumed', async () => {
    const gate = new MediaWriteGate()
    let release: (() => void) | null = null
    const active = gate.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const paused = gate.pause()
    await expect(gate.run(async () => undefined)).rejects.toThrow(/paused/)
    callDeferredRelease(release)
    await active
    await paused
    gate.resume()
    await expect(gate.run(async () => undefined)).resolves.toBeUndefined()
  })
})
