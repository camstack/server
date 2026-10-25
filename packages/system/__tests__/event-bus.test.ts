import { describe, it, expect, vi } from 'vitest'
import { EventBus } from '../src/events/event-bus'

describe('EventBus', () => {
  it('on/emit: listener receives emitted data', () => {
    const bus = new EventBus()
    const cb = vi.fn()
    bus.on('test', cb)
    bus.emit('test', { value: 42 })
    expect(cb).toHaveBeenCalledOnce()
    expect(cb).toHaveBeenCalledWith({ value: 42 })
  })

  it('emit: does nothing when no listeners registered', () => {
    const bus = new EventBus()
    expect(() => bus.emit('nonexistent', 'data')).not.toThrow()
  })

  it('once: fires only once', () => {
    const bus = new EventBus()
    const cb = vi.fn()
    bus.once('event', cb)
    bus.emit('event', 1)
    bus.emit('event', 2)
    bus.emit('event', 3)
    expect(cb).toHaveBeenCalledOnce()
    expect(cb).toHaveBeenCalledWith(1)
  })

  it('unsubscribe: returned function removes the listener', () => {
    const bus = new EventBus()
    const cb = vi.fn()
    const unsub = bus.on('event', cb)
    bus.emit('event', 'a')
    unsub()
    bus.emit('event', 'b')
    expect(cb).toHaveBeenCalledOnce()
  })

  it('removeAllListeners: removes listeners for specific event', () => {
    const bus = new EventBus()
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    bus.on('alpha', cb1)
    bus.on('beta', cb2)
    bus.removeAllListeners('alpha')
    bus.emit('alpha', 1)
    bus.emit('beta', 2)
    expect(cb1).not.toHaveBeenCalled()
    expect(cb2).toHaveBeenCalledOnce()
  })

  it('removeAllListeners: clears all events when no argument given', () => {
    const bus = new EventBus()
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    bus.on('alpha', cb1)
    bus.on('beta', cb2)
    bus.removeAllListeners()
    bus.emit('alpha', 1)
    bus.emit('beta', 2)
    expect(cb1).not.toHaveBeenCalled()
    expect(cb2).not.toHaveBeenCalled()
  })

  it('listenerCount: returns correct count', () => {
    const bus = new EventBus()
    expect(bus.listenerCount('x')).toBe(0)
    const unsub = bus.on('x', vi.fn())
    bus.on('x', vi.fn())
    expect(bus.listenerCount('x')).toBe(2)
    unsub()
    expect(bus.listenerCount('x')).toBe(1)
  })

  it('error in one listener does not break other listeners', () => {
    const bus = new EventBus()
    const good = vi.fn()
    bus.on('event', () => {
      throw new Error('boom')
    })
    bus.on('event', good)
    expect(() => bus.emit('event', 'data')).not.toThrow()
    expect(good).toHaveBeenCalledWith('data')
  })

  it('multiple events are isolated', () => {
    const bus = new EventBus()
    const cbA = vi.fn()
    const cbB = vi.fn()
    bus.on('A', cbA)
    bus.on('B', cbB)
    bus.emit('A', 'hello')
    expect(cbA).toHaveBeenCalledWith('hello')
    expect(cbB).not.toHaveBeenCalled()
  })
})
