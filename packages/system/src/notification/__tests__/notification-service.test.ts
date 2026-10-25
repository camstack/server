import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NotificationService } from '../notification-service.js'
import type { INotificationOutputProvider, RoutedNotification } from '@camstack/types'
import type { IScopedLogger } from '../../logging/scoped-logger.js'

function createMockLogger(): IScopedLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as IScopedLogger
}

function createMockProvider(): INotificationOutputProvider {
  return {
    send: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as INotificationOutputProvider
}

function createNotification(overrides: Partial<RoutedNotification> = {}): RoutedNotification {
  return {
    title: 'Test',
    body: 'Test notification',
    format: 'text',
    priority: 3,
    category: 'detection',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('NotificationService', () => {
  let service: NotificationService
  let logger: IScopedLogger

  beforeEach(() => {
    logger = createMockLogger()
    service = new NotificationService(logger)
  })

  it('routes a notification to each configured (addonId, targetId) target', async () => {
    const notifiers = createMockProvider()
    const ha = createMockProvider()
    service.registerLocalProvider('notifiers', notifiers)
    service.registerLocalProvider('ha', ha)
    service.setRouting('detection', [
      { addonId: 'notifiers', targetId: 't1' },
      { addonId: 'ha', targetId: 't2' },
    ])

    const notification = createNotification()
    await service.notify(notification)

    expect(notifiers.send).toHaveBeenCalledTimes(1)
    expect(ha.send).toHaveBeenCalledTimes(1)
    expect(notifiers.send).toHaveBeenCalledWith({
      targetId: 't1',
      notification: expect.objectContaining({ body: 'Test notification', priority: 3 }),
    })
    expect(ha.send).toHaveBeenCalledWith({
      targetId: 't2',
      notification: expect.objectContaining({ body: 'Test notification' }),
    })
  })

  it('strips the consumer envelope (category / timestamp) from the cap payload', async () => {
    const provider = createMockProvider()
    service.registerLocalProvider('notifiers', provider)
    service.setRouting('detection', [{ addonId: 'notifiers', targetId: 't1' }])

    await service.notify(createNotification())

    const sendMock = provider.send as ReturnType<typeof vi.fn>
    const payload = sendMock.mock.calls[0]![0] as { notification: Record<string, unknown> }
    expect(payload.notification).not.toHaveProperty('category')
    expect(payload.notification).not.toHaveProperty('timestamp')
  })

  it('dispatches the same target to multiple providers by addonId', async () => {
    const notifiers = createMockProvider()
    const ha = createMockProvider()
    service.registerLocalProvider('notifiers', notifiers)
    service.registerLocalProvider('ha', ha)
    service.setRouting('motion', [
      { addonId: 'notifiers', targetId: 't1' },
      { addonId: 'ha', targetId: 't2' },
    ])

    await service.notify(createNotification({ category: 'motion' }))

    expect((notifiers.send as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      targetId: 't1',
    })
    expect((ha.send as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      targetId: 't2',
    })
  })

  it('rate limits notifications for same category+device within interval', async () => {
    const provider = createMockProvider()
    service.registerLocalProvider('notifiers', provider)
    service.setRouting('detection', [{ addonId: 'notifiers', targetId: 't1' }])
    service.setRateLimit('detection', 30000)

    const now = Date.now()
    await service.notify(createNotification({ timestamp: now, deviceId: 1 }))
    await service.notify(createNotification({ timestamp: now + 10000, deviceId: 1 }))

    expect(provider.send).toHaveBeenCalledTimes(1)
  })

  it('allows notifications for different devices even with rate limiting', async () => {
    const provider = createMockProvider()
    service.registerLocalProvider('notifiers', provider)
    service.setRouting('detection', [{ addonId: 'notifiers', targetId: 't1' }])
    service.setRateLimit('detection', 30000)

    const now = Date.now()
    await service.notify(createNotification({ timestamp: now, deviceId: 1 }))
    await service.notify(createNotification({ timestamp: now + 1000, deviceId: 2 }))

    expect(provider.send).toHaveBeenCalledTimes(2)
  })

  it('routes by category', async () => {
    const detect = createMockProvider()
    const system = createMockProvider()
    service.registerLocalProvider('detect-addon', detect)
    service.registerLocalProvider('system-addon', system)
    service.setRouting('detection', [{ addonId: 'detect-addon', targetId: 't1' }])
    service.setRouting('system', [{ addonId: 'system-addon', targetId: 't2' }])

    await service.notify(createNotification({ category: 'detection' }))
    await service.notify(createNotification({ category: 'system' }))

    expect(detect.send).toHaveBeenCalledTimes(1)
    expect(system.send).toHaveBeenCalledTimes(1)
  })

  it('error in one target does not block others (allSettled isolation)', async () => {
    const failing = createMockProvider()
    ;(failing.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Send failed'))
    const working = createMockProvider()

    service.registerLocalProvider('failing', failing)
    service.registerLocalProvider('working', working)
    service.setRouting('detection', [
      { addonId: 'failing', targetId: 't1' },
      { addonId: 'working', targetId: 't2' },
    ])

    await service.notify(createNotification())

    expect(working.send).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalled()
  })

  it('uses catch-all routing when category not configured', async () => {
    const provider = createMockProvider()
    service.registerLocalProvider('notifiers', provider)
    service.setRouting('*', [{ addonId: 'notifiers', targetId: 't1' }])

    await service.notify(createNotification({ category: 'unknown-category' }))

    expect(provider.send).toHaveBeenCalledTimes(1)
  })

  it('does not send when no routing is configured', async () => {
    const provider = createMockProvider()
    service.registerLocalProvider('notifiers', provider)

    await service.notify(createNotification())

    expect(provider.send).not.toHaveBeenCalled()
  })

  it('getRouting exposes the configured routing map', () => {
    service.setRouting('detection', [{ addonId: 'notifiers', targetId: 't1' }])
    const routing = service.getRouting()
    expect(routing.get('detection')).toEqual([{ addonId: 'notifiers', targetId: 't1' }])
  })

  it('unregisterLocalProvider removes the provider', async () => {
    const provider = createMockProvider()
    service.registerLocalProvider('notifiers', provider)
    service.setRouting('detection', [{ addonId: 'notifiers', targetId: 't1' }])
    service.unregisterLocalProvider('notifiers')

    await service.notify(createNotification())

    expect(provider.send).not.toHaveBeenCalled()
  })
})
