import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToastService } from '../toast-service.js'
import type { Toast } from '@camstack/types'

function createToast(overrides: Partial<Toast> = {}): Toast {
  return {
    title: 'Test',
    message: 'Test toast',
    severity: 'info',
    ...overrides,
  }
}

describe('ToastService', () => {
  let service: ToastService

  beforeEach(() => {
    service = new ToastService()
  })

  it('broadcast sends to all listeners', () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    service.subscribe('conn1', 'user1', cb1)
    service.subscribe('conn2', 'user2', cb2)

    const toast = createToast()
    service.broadcast(toast)

    expect(cb1).toHaveBeenCalledWith(toast)
    expect(cb2).toHaveBeenCalledWith(toast)
  })

  it("sendToUser sends only to that user's listeners", () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    const cb3 = vi.fn()
    service.subscribe('conn1', 'user1', cb1)
    service.subscribe('conn2', 'user2', cb2)
    service.subscribe('conn3', 'user1', cb3)

    const toast = createToast()
    service.sendToUser('user1', toast)

    expect(cb1).toHaveBeenCalledWith(toast)
    expect(cb2).not.toHaveBeenCalled()
    expect(cb3).toHaveBeenCalledWith(toast)
  })

  it('subscribe returns unsubscribe function', () => {
    const cb = vi.fn()
    const unsubscribe = service.subscribe('conn1', 'user1', cb)

    unsubscribe()
    service.broadcast(createToast())

    expect(cb).not.toHaveBeenCalled()
  })

  it('unsubscribed listeners do not receive messages', () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    const unsub1 = service.subscribe('conn1', 'user1', cb1)
    service.subscribe('conn2', 'user2', cb2)

    unsub1()

    const toast = createToast()
    service.broadcast(toast)

    expect(cb1).not.toHaveBeenCalled()
    expect(cb2).toHaveBeenCalledWith(toast)
  })
})
