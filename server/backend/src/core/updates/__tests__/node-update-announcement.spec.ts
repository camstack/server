import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import {
  announceProductVersionChange,
  buildNodeUpdateAnnouncement,
  detectProductVersionChange,
} from '../node-update-announcement'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-update-announcement-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('buildNodeUpdateAnnouncement', () => {
  it('is a framework-update that names WHAT is replaced and both versions', () => {
    expect(
      buildNodeUpdateAnnouncement({
        what: 'desktop-shell',
        fromVersion: '1.2.10',
        toVersion: '1.2.11',
        requestedAt: 5,
      }),
    ).toEqual({
      kind: 'framework-update',
      what: 'desktop-shell',
      packageName: 'CamStack desktop app',
      fromVersion: '1.2.10',
      toVersion: '1.2.11',
      requestedAt: 5,
    })
  })

  it('omits a version that is not known instead of inventing one', () => {
    const payload = buildNodeUpdateAnnouncement({
      what: 'container-image',
      requestedAt: 1,
    })
    expect(payload.packageName).toBe('CamStack container image')
    expect('toVersion' in payload).toBe(false)
    expect('fromVersion' in payload).toBe(false)
  })
})

describe('detectProductVersionChange', () => {
  it('records the first boot and reports no change', () => {
    expect(detectProductVersionChange(dir, '1.2.10')).toBeNull()
    expect(detectProductVersionChange(dir, '1.2.10')).toBeNull()
  })

  it('reports the previous and the new version once, then is quiet again', () => {
    detectProductVersionChange(dir, '1.2.10')
    expect(detectProductVersionChange(dir, '1.2.11')).toEqual({
      from: '1.2.10',
      to: '1.2.11',
    })
    expect(detectProductVersionChange(dir, '1.2.11')).toBeNull()
  })

  it('reads an unset product version as unknown: nothing recorded, nothing reported', () => {
    detectProductVersionChange(dir, '1.2.10')
    expect(detectProductVersionChange(dir, null)).toBeNull()
    // The record survived: the next real version is still compared to 1.2.10.
    expect(detectProductVersionChange(dir, '1.2.11')).toEqual({
      from: '1.2.10',
      to: '1.2.11',
    })
  })
})

describe('announceProductVersionChange', () => {
  function logger(): IScopedLogger {
    const instance: IScopedLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child: () => instance,
      withTags: () => instance,
    }
    return instance
  }
  function run(productVersion: string | null, underDesktopShell = false): SystemEvent[] {
    const emitted: SystemEvent[] = []
    const bus = {
      emit: (e: SystemEvent) => emitted.push(e),
    } as unknown as IEventBus
    announceProductVersionChange({
      dataDir: dir,
      productVersion,
      underDesktopShell,
      bus,
      sourceId: 'test',
      nodeId: 'agent-a',
      logger: logger(),
      now: () => 7,
    })
    return emitted
  }

  it('announces a container that booted on a different image than its previous boot', () => {
    expect(run('1.2.10')).toEqual([])
    const emitted = run('1.2.11')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      category: 'system.restarting',
      data: {
        kind: 'framework-update',
        what: 'container-image',
        fromVersion: '1.2.10',
        toVersion: '1.2.11',
        nodeId: 'agent-a',
        requestedAt: 7,
      },
    })
    expect(run('1.2.11')).toEqual([])
  })

  it('stays silent under the desktop shell (its own update is announced when it installs) but still records', () => {
    run('1.2.10', true)
    expect(run('1.2.11', true)).toEqual([])
    expect(run('1.2.12')[0]).toMatchObject({ data: { fromVersion: '1.2.11' } })
  })
})
