/**
 * RestartCoordinator — marker round-trip + failure handling.
 *
 * Spec: docs/superpowers/specs/2026-05-14-framework-live-update-design.md (P2)
 *
 * Invariants under test:
 *   - Round-trip: write then read returns the same payload, marker is gone.
 *   - Atomicity: a half-written tmp file never bleeds into the marker (we
 *     can't easily simulate a crash mid-write in a unit test, but the
 *     write-then-rename path is exercised — if rename failed, no marker
 *     would exist).
 *   - Read fails closed: malformed JSON clears the marker (so we don't
 *     wedge the boot path forever) and returns null.
 *   - Read fails closed: missing required fields clears the marker.
 *   - No marker → null (no clear needed; just absence).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  clearPendingRestart,
  getRestartMarkerPath,
  readPendingRestart,
  RESTART_MARKER_FILE,
  writePendingRestart,
  type PendingRestartMarker,
} from '../restart-coordinator.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-coordinator-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('RestartCoordinator marker round-trip', () => {
  it('writes then reads the same payload and clears the marker', () => {
    const marker: PendingRestartMarker = {
      kind: 'framework-update',
      packageName: '@camstack/system',
      fromVersion: '0.1.36',
      toVersion: '0.1.37',
      requestedBy: 'admin',
      requestedAt: 1715717834567,
    }

    writePendingRestart(tmpDir, marker)
    expect(fs.existsSync(getRestartMarkerPath(tmpDir))).toBe(true)

    const read = readPendingRestart(tmpDir)
    expect(read).toEqual(marker)
    expect(fs.existsSync(getRestartMarkerPath(tmpDir))).toBe(false)
  })

  it('returns null when no marker exists', () => {
    expect(readPendingRestart(tmpDir)).toBeNull()
  })

  it('round-trips a minimal manual restart payload (no optional fields)', () => {
    const marker: PendingRestartMarker = {
      kind: 'manual',
      requestedAt: 42,
    }
    writePendingRestart(tmpDir, marker)
    expect(readPendingRestart(tmpDir)).toEqual(marker)
  })

  it('overwrites a previous marker — last writer wins', () => {
    writePendingRestart(tmpDir, { kind: 'manual', requestedAt: 1 })
    writePendingRestart(tmpDir, {
      kind: 'framework-update',
      packageName: '@camstack/types',
      requestedAt: 2,
    })

    const read = readPendingRestart(tmpDir)
    expect(read?.kind).toBe('framework-update')
    expect(read?.packageName).toBe('@camstack/types')
    expect(read?.requestedAt).toBe(2)
  })

  it('creates the dataDir if it does not exist yet', () => {
    const subDir = path.join(tmpDir, 'nested', 'data')
    expect(fs.existsSync(subDir)).toBe(false)

    writePendingRestart(subDir, { kind: 'manual', requestedAt: 1 })
    expect(fs.existsSync(getRestartMarkerPath(subDir))).toBe(true)
  })
})

describe('RestartCoordinator failure handling', () => {
  it('clears a malformed JSON marker and returns null', () => {
    const markerPath = path.join(tmpDir, RESTART_MARKER_FILE)
    fs.writeFileSync(markerPath, '{ not valid json', 'utf-8')

    expect(readPendingRestart(tmpDir)).toBeNull()
    expect(fs.existsSync(markerPath)).toBe(false)
  })

  it('clears a marker missing the kind field and returns null', () => {
    const markerPath = path.join(tmpDir, RESTART_MARKER_FILE)
    fs.writeFileSync(markerPath, JSON.stringify({ requestedAt: 123 }), 'utf-8')

    expect(readPendingRestart(tmpDir)).toBeNull()
    expect(fs.existsSync(markerPath)).toBe(false)
  })

  it('clears a marker with an unknown kind value and returns null', () => {
    const markerPath = path.join(tmpDir, RESTART_MARKER_FILE)
    fs.writeFileSync(markerPath, JSON.stringify({ kind: 'rogue', requestedAt: 1 }), 'utf-8')

    expect(readPendingRestart(tmpDir)).toBeNull()
    expect(fs.existsSync(markerPath)).toBe(false)
  })

  it('clears a marker with a zero/negative requestedAt and returns null', () => {
    const markerPath = path.join(tmpDir, RESTART_MARKER_FILE)
    fs.writeFileSync(markerPath, JSON.stringify({ kind: 'manual', requestedAt: 0 }), 'utf-8')

    expect(readPendingRestart(tmpDir)).toBeNull()
    expect(fs.existsSync(markerPath)).toBe(false)
  })

  it('clearPendingRestart is idempotent when no marker exists', () => {
    expect(() => clearPendingRestart(tmpDir)).not.toThrow()
  })

  it('clearPendingRestart removes an existing marker', () => {
    writePendingRestart(tmpDir, { kind: 'manual', requestedAt: 1 })
    expect(fs.existsSync(getRestartMarkerPath(tmpDir))).toBe(true)

    clearPendingRestart(tmpDir)
    expect(fs.existsSync(getRestartMarkerPath(tmpDir))).toBe(false)
  })
})
