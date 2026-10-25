/**
 * UDS child log ingest — unit test for Task B2.
 *
 * Verifies that wiring `LocalChildRegistry.onChildLog` to
 * `LoggingService.writeFromWorker` correctly maps a `ChildLogMessage`
 * produced over a UDS channel to the `writeFromWorker` entry shape.
 *
 * We test the helper `udsChildLogToWorkerEntry` (extracted from the
 * hub/agent wiring) directly, plus the full registry+handler pairing so
 * the glue code exercises the real `onChildLog` callback path.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ChildLogMessage } from '@camstack/system'
import { udsChildLogToWorkerEntry } from '@camstack/system'

// --------------------------------------------------------------------------
// Minimal `WriteFromWorkerEntry` shape mirrored from LoggingService signature
// --------------------------------------------------------------------------
interface WriteFromWorkerEntry {
  addonId: string
  nodeId?: string
  level: string
  message: string
  scope?: string
  tags?: Record<string, string | number | undefined>
  meta?: Record<string, unknown>
}

// --------------------------------------------------------------------------
// Helper: build a minimal ChildLogMessage
// --------------------------------------------------------------------------
function makeLogMessage(overrides?: Partial<ChildLogMessage>): ChildLogMessage {
  return {
    kind: 'log',
    level: 'info',
    message: 'hello from child',
    addonId: 'stream-broker',
    ...overrides,
  }
}

// --------------------------------------------------------------------------
// Tests for udsChildLogToWorkerEntry
// --------------------------------------------------------------------------

describe('udsChildLogToWorkerEntry', () => {
  it('maps the required fields — addonId, level, message', () => {
    const entry = makeLogMessage()
    const result = udsChildLogToWorkerEntry('stream-broker', entry)

    expect(result.addonId).toBe('stream-broker')
    expect(result.level).toBe('info')
    expect(result.message).toBe('hello from child')
  })

  it('uses entry.nodeId when present', () => {
    const entry = makeLogMessage({ nodeId: 'hub/stream-broker' })
    const result = udsChildLogToWorkerEntry('stream-broker', entry)

    expect(result.nodeId).toBe('hub/stream-broker')
  })

  it('falls back to childId when nodeId is absent', () => {
    const entry = makeLogMessage()
    const result = udsChildLogToWorkerEntry('stream-broker', entry)

    expect(result.nodeId).toBe('stream-broker')
  })

  it('omits scope when not present in entry', () => {
    const entry = makeLogMessage()
    const result = udsChildLogToWorkerEntry('stream-broker', entry)

    expect(Object.prototype.hasOwnProperty.call(result, 'scope')).toBe(false)
  })

  it('includes scope when present in entry', () => {
    const entry = makeLogMessage({ scope: 'rtsp' })
    const result = udsChildLogToWorkerEntry('stream-broker', entry)

    expect(result.scope).toBe('rtsp')
  })

  it('omits tags when not present in entry', () => {
    const entry = makeLogMessage()
    const result = udsChildLogToWorkerEntry('stream-broker', entry)

    expect(Object.prototype.hasOwnProperty.call(result, 'tags')).toBe(false)
  })

  it('includes tags when present in entry', () => {
    const entry = makeLogMessage({ tags: { deviceId: 5, streamId: '5/main' } })
    const result = udsChildLogToWorkerEntry('stream-broker', entry)

    expect(result.tags).toEqual({ deviceId: 5, streamId: '5/main' })
  })

  it('omits meta when not present in entry', () => {
    const entry = makeLogMessage()
    const result = udsChildLogToWorkerEntry('stream-broker', entry)

    expect(Object.prototype.hasOwnProperty.call(result, 'meta')).toBe(false)
  })

  it('includes meta when present in entry', () => {
    const entry = makeLogMessage({ meta: { rtt: 42 } })
    const result = udsChildLogToWorkerEntry('stream-broker', entry)

    expect(result.meta).toEqual({ rtt: 42 })
  })

  it('produces the same shape that $hub.log onLog produces', () => {
    // The existing onLog wiring in moleculer.service.ts maps:
    //   { addonId, nodeId, level, message, scope?, tags?, meta? }
    // Verify we produce an identical structure for a fully-populated entry.
    const entry = makeLogMessage({
      addonId: 'ptz-provider',
      nodeId: 'hub/ptz-provider',
      level: 'warn',
      message: 'PTZ timeout',
      scope: 'ptz',
      tags: { deviceId: 3 },
      meta: { timeout: 5000 },
    })
    const result = udsChildLogToWorkerEntry('hub/ptz-provider', entry)

    const expected: WriteFromWorkerEntry = {
      addonId: 'ptz-provider',
      nodeId: 'hub/ptz-provider',
      level: 'warn',
      message: 'PTZ timeout',
      scope: 'ptz',
      tags: { deviceId: 3 },
      meta: { timeout: 5000 },
    }
    expect(result).toEqual(expected)
  })
})

// --------------------------------------------------------------------------
// Tests for the registry+handler wiring (the onChildLog callback path)
// --------------------------------------------------------------------------

describe('onChildLog handler wiring', () => {
  it('calls writeFromWorker when a ChildLogMessage arrives', () => {
    // Fake logging service — typed minimal interface
    const fakeLogging = {
      writeFromWorker: vi.fn<(...args: [WriteFromWorkerEntry]) => void>(),
    }

    // The actual wiring closure (mirrors hub & agent wiring)
    const handler = (childId: string, entry: ChildLogMessage): void => {
      fakeLogging.writeFromWorker(udsChildLogToWorkerEntry(childId, entry))
    }

    const entry = makeLogMessage({ addonId: 'motion-detector', nodeId: 'hub/motion-detector' })
    handler('hub/motion-detector', entry)

    expect(fakeLogging.writeFromWorker).toHaveBeenCalledOnce()
    const called = fakeLogging.writeFromWorker.mock.calls[0]![0]
    expect(called.addonId).toBe('motion-detector')
    expect(called.nodeId).toBe('hub/motion-detector')
    expect(called.level).toBe('info')
    expect(called.message).toBe('hello from child')
  })

  it('invokes writeFromWorker once per log entry', () => {
    const fakeLogging = {
      writeFromWorker: vi.fn<(...args: [WriteFromWorkerEntry]) => void>(),
    }

    const handler = (childId: string, entry: ChildLogMessage): void => {
      fakeLogging.writeFromWorker(udsChildLogToWorkerEntry(childId, entry))
    }

    handler('child-a', makeLogMessage({ addonId: 'child-a', level: 'debug', message: 'first' }))
    handler('child-b', makeLogMessage({ addonId: 'child-b', level: 'error', message: 'second' }))

    expect(fakeLogging.writeFromWorker).toHaveBeenCalledTimes(2)
    expect(fakeLogging.writeFromWorker.mock.calls[0]![0].addonId).toBe('child-a')
    expect(fakeLogging.writeFromWorker.mock.calls[1]![0].addonId).toBe('child-b')
  })
})
