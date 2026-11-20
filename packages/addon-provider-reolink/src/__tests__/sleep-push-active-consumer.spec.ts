import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { shouldIgnoreSleepPush } from '../sleep-state-decision.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

describe('firmware sleeping push with an attached consumer', () => {
  it('is ignored while streams are active, acted on when none are', () => {
    expect(shouldIgnoreSleepPush({ activeStreams: 2 })).toBe(true)
    expect(shouldIgnoreSleepPush({ activeStreams: 0 })).toBe(false)
  })

  it("the 'sleeping' handler consults the guard BEFORE committing sleep or closing streams", () => {
    const start = source.indexOf("if (event.type === 'sleeping')")
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 3500)
    const guard = body.indexOf('shouldIgnoreSleepPush({ activeStreams: this.active.size })')
    const commit = body.indexOf("commitSleepState(true, 'simple-event')")
    const close = body.indexOf("closeActiveStreams('sleeping')")
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(commit)
    expect(guard).toBeLessThan(close)
    expect(body.slice(guard, commit)).toMatch(/\breturn\b/)
  })
})
