import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  clearManifest,
  manifestPath,
  planPause,
  readManifest,
  writeManifest,
  type PauseManifest,
} from '../auto-pause.js'

/**
 * The measurement needs a quiet node; the operator needs every camera back.
 * These pin the second, because a pause that cannot prove it was undone leaves
 * cameras blind while their config says they are watching — the worst failure
 * this system has.
 */
let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-pause-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const manifest = (over: Partial<PauseManifest> = {}): PauseManifest => ({
  takenAtMs: 1_700_000_000_000,
  nodeId: 'hub',
  cameras: [
    { deviceId: 101, detectionMode: 'on-motion' },
    { deviceId: 102, detectionMode: 'always-on' },
  ],
  ...over,
})

describe('the restore manifest', () => {
  it('round-trips what has to be put back', () => {
    writeManifest(dir, manifest())
    expect(readManifest(dir)).toEqual(manifest())
  })

  it('survives a crash — it is on disk, not in memory', () => {
    writeManifest(dir, manifest())
    // Simulate the process dying: nothing in-process remains, only the file.
    expect(fs.existsSync(manifestPath(dir))).toBe(true)
    expect(readManifest(dir)?.cameras).toHaveLength(2)
  })

  it('a corrupt manifest reads as null instead of throwing', () => {
    // It must never stop the very process that would restore the cameras.
    fs.writeFileSync(manifestPath(dir), '{ not json', 'utf8')
    expect(readManifest(dir)).toBeNull()
  })

  it('a manifest missing required fields is rejected, not half-applied', () => {
    fs.writeFileSync(manifestPath(dir), JSON.stringify({ nodeId: 'hub' }), 'utf8')
    expect(readManifest(dir)).toBeNull()
  })

  it('an absent manifest is null, not an error', () => {
    expect(readManifest(dir)).toBeNull()
  })

  it('clearing is idempotent — a double clear must not throw', () => {
    writeManifest(dir, manifest())
    clearManifest(dir)
    expect(readManifest(dir)).toBeNull()
    expect(() => clearManifest(dir)).not.toThrow()
  })

  it('the write is atomic — no .tmp is left behind', () => {
    writeManifest(dir, manifest())
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('planning the pause', () => {
  it('records the mode to restore, per camera', () => {
    expect(
      planPause([
        { deviceId: 101, detectionMode: 'on-motion' },
        { deviceId: 102, detectionMode: 'always-on' },
      ]),
    ).toEqual([
      { deviceId: 101, detectionMode: 'on-motion' },
      { deviceId: 102, detectionMode: 'always-on' },
    ])
  })

  it('leaves an already-disabled camera OUT of the manifest', () => {
    // Restoring it to 'disabled' is harmless, but claiming responsibility for a
    // state the ramp did not cause is not: on replay it is indistinguishable
    // from a camera the operator disabled deliberately.
    expect(
      planPause([
        { deviceId: 101, detectionMode: 'disabled' },
        { deviceId: 102, detectionMode: 'on-motion' },
      ]),
    ).toEqual([{ deviceId: 102, detectionMode: 'on-motion' }])
  })

  it('an all-quiet node needs no manifest at all', () => {
    expect(planPause([{ deviceId: 101, detectionMode: 'disabled' }])).toEqual([])
  })
})
