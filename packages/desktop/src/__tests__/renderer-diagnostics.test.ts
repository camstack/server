import { describe, expect, it } from 'vitest'
import { computeRespawn, formatRendererEvent, shouldToggleDevTools } from '../renderer-diagnostics'

describe('shouldToggleDevTools', () => {
  const base = { type: 'keyDown', key: 'i', alt: true, meta: true, control: false }

  it('matches Cmd+Alt+I (macOS)', () => {
    expect(shouldToggleDevTools(base)).toBe(true)
    expect(shouldToggleDevTools({ ...base, key: 'I' })).toBe(true)
  })

  it('matches Ctrl+Alt+I (Windows/Linux)', () => {
    expect(shouldToggleDevTools({ ...base, meta: false, control: true })).toBe(true)
  })

  it('matches F12 without modifiers', () => {
    expect(
      shouldToggleDevTools({
        type: 'keyDown',
        key: 'F12',
        alt: false,
        meta: false,
        control: false,
      }),
    ).toBe(true)
  })

  it('ignores keyUp and plain keys', () => {
    expect(shouldToggleDevTools({ ...base, type: 'keyUp' })).toBe(false)
    expect(shouldToggleDevTools({ ...base, alt: false })).toBe(false)
    expect(
      shouldToggleDevTools({ type: 'keyDown', key: 'i', alt: false, meta: false, control: false }),
    ).toBe(false)
  })
})

describe('formatRendererEvent', () => {
  it('renders a stable single-line prefix + fields', () => {
    const line = formatRendererEvent('did-fail-load', {
      errorCode: -102,
      errorDescription: 'ERR_CONNECTION_REFUSED',
      validatedURL: 'http://localhost:4444/',
    })
    expect(line).toBe(
      '[renderer:did-fail-load] errorCode=-102 errorDescription=ERR_CONNECTION_REFUSED validatedURL=http://localhost:4444/',
    )
  })

  it('flattens newlines so one event stays one log line', () => {
    const line = formatRendererEvent('console:error', { message: 'boom\nstack line' })
    expect(line).toBe('[renderer:console:error] message=boom\\nstack line')
  })
})

describe('computeRespawn', () => {
  it('backs off exponentially on consecutive fast crashes', () => {
    let state = { consecutiveCrashes: 0 }
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      const next = computeRespawn(state, 1_000)
      state = next.state
      delays.push(next.delayMs)
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
  })

  it('resets the backoff after the child stayed up for a minute', () => {
    const crashed = computeRespawn({ consecutiveCrashes: 5 }, 120_000)
    expect(crashed.state.consecutiveCrashes).toBe(1)
    expect(crashed.delayMs).toBe(1_000)
  })
})
