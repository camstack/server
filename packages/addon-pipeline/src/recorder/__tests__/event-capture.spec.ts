import { describe, it, expect } from 'vitest'
import { isMotionTrigger, subscribeEventCapture } from '../event-capture.js'

describe('isMotionTrigger', () => {
  it('the rising edge is a trigger', () => {
    expect(isMotionTrigger({ deviceId: 99, detected: true, timestamp: 100_000 })).toBe(true)
  })
  it('the falling edge opens nothing — the post-buffer closes the window', () => {
    expect(isMotionTrigger({ deviceId: 99, detected: false, timestamp: 100_000 })).toBe(false)
  })
})

describe('subscribeEventCapture', () => {
  it('calls onMotion once per event with detected, and never on the falling edge', () => {
    let motionHandler:
      | ((e: { data: { deviceId: number; detected: boolean; timestamp: number } }) => void)
      | null = null
    let unsubbed = false
    const bus = {
      subscribe: (_filter: { category: string }, handler: (e: never) => void) => {
        motionHandler = handler as never
        return () => {
          unsubbed = true
        }
      },
    }
    const seen: Array<[number, number]> = []
    const unsub = subscribeEventCapture({
      eventBus: bus,
      onMotion: (deviceId, atMs) => seen.push([deviceId, atMs]),
    })

    motionHandler!({ data: { deviceId: 99, detected: true, timestamp: 100000 } })
    motionHandler!({ data: { deviceId: 99, detected: false, timestamp: 101000 } })

    expect(seen).toEqual([[99, 100000]])
    unsub()
    expect(unsubbed).toBe(true)
  })
})
