import { describe, it, expect } from 'vitest'
import { CAP_INPUT_DEFAULTS, withCapInputDefaults } from '../cap-input-defaults.js'
import { recordingArchiveCapability } from '../../capabilities/recording-archive.cap.js'
import { notificationOutputCapability } from '../../capabilities/notification-output.cap.js'

/**
 * The generated map exists because a Zod `.default()` runs only where the
 * schema is PARSED. Every assertion here is anchored to a REAL production
 * failure of 2026-07-30, so a regression reads as the outage it was.
 */
describe('CAP_INPUT_DEFAULTS', () => {
  it('carries the gif roll window that arrived undefined and produced NaN', () => {
    const filled = withCapInputDefaults('recording-archive', 'renderGif', {
      deviceId: 101,
      aroundMs: 1_000_000,
    })
    expect(filled).toMatchObject({ preRollSec: 2, postRollSec: 5, maxWidth: 480, fps: 5 })
  })

  it('agrees with the REAL schema — the map cannot drift from the cap', () => {
    const parsed = recordingArchiveCapability.methods.renderGif.input.parse({
      deviceId: 1,
      aroundMs: 2,
    })
    const filled = withCapInputDefaults('recording-archive', 'renderGif', {
      deviceId: 1,
      aroundMs: 2,
    })
    expect(filled).toEqual(parsed)
  })

  it('reaches ONE level down — the `format` default lives inside `notification`', () => {
    const filled = withCapInputDefaults('notification-output', 'send', {
      addonId: 'notifiers',
      targetId: 't1',
      notification: { body: 'hello' },
    })
    expect(filled).toMatchObject({ notification: { body: 'hello', format: 'text' } })
    // …and matches what the router path would have produced.
    const parsed = notificationOutputCapability.methods.send.input.parse({
      addonId: 'notifiers',
      targetId: 't1',
      notification: { body: 'hello' },
    })
    expect((filled as { notification: { format: string } }).notification.format).toBe(
      parsed.notification.format,
    )
  })

  it('NEVER overrides a caller value, at either level', () => {
    const filled = withCapInputDefaults('recording-archive', 'renderGif', {
      deviceId: 1,
      aroundMs: 2,
      preRollSec: 30,
    })
    expect((filled as { preRollSec: number }).preRollSec).toBe(30)
    const nested = withCapInputDefaults('notification-output', 'send', {
      addonId: 'a',
      targetId: 't',
      notification: { body: 'x', format: 'markdown' },
    })
    expect((nested as { notification: { format: string } }).notification.format).toBe('markdown')
  })

  // The addon path carries its routing pin INLINE in the args. A Zod parse
  // would strip it and silently route the call to the wrong node — which is
  // why this helper merges instead of parsing.
  it('leaves unknown keys (the inline nodeId routing pin) untouched', () => {
    const filled = withCapInputDefaults('recording-archive', 'renderGif', {
      deviceId: 1,
      aroundMs: 2,
      nodeId: 'agent-a',
    })
    expect((filled as { nodeId: string }).nodeId).toBe('agent-a')
  })

  it('passes through a method with no declared defaults, by identity', () => {
    const input = { deviceId: 7 }
    expect(withCapInputDefaults('recording-archive', 'getDeviceConfig', input)).toBe(input)
  })

  it('passes through a non-object input untouched', () => {
    expect(withCapInputDefaults('recording-archive', 'renderGif', 42)).toBe(42)
  })

  it('materialises the whole group when the caller passed nothing', () => {
    const filled = withCapInputDefaults('recording-archive', 'renderGif', undefined)
    expect(filled).toEqual({ preRollSec: 2, postRollSec: 5, maxWidth: 480, fps: 5 })
  })

  it('the map is non-empty and names the caps that broke production', () => {
    expect(Object.keys(CAP_INPUT_DEFAULTS).length).toBeGreaterThan(10)
    expect(CAP_INPUT_DEFAULTS['recording-archive']?.['renderGif']).toBeDefined()
    expect(CAP_INPUT_DEFAULTS['notification-output']?.['send']).toBeDefined()
  })
})
