import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { installManifestNativeDeps } from '../deps/manifest-native-deps.js'

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => noopLogger,
  withTags: () => noopLogger,
}

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-deps-test-'))
  vi.clearAllMocks()
})

describe('installManifestNativeDeps', () => {
  it('is a no-op when nativeDependencies is missing', async () => {
    await installManifestNativeDeps(tmpDir, { name: 'foo' }, noopLogger)
    expect(noopLogger.info).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(tmpDir, '.camstack-native-deps-installed'))).toBe(false)
  })

  it('is a no-op when nativeDependencies is empty', async () => {
    await installManifestNativeDeps(
      tmpDir,
      { name: 'foo', camstack: { nativeDependencies: {} } },
      noopLogger,
    )
    expect(noopLogger.info).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(tmpDir, '.camstack-native-deps-installed'))).toBe(false)
  })

  it('skips re-install when marker hash matches the declaration', async () => {
    const declaration = {
      name: 'foo',
      camstack: {
        nativeDependencies: { 'better-sqlite3': '^12.8.0' },
      },
    }
    // Pre-write the marker with the hash this declaration would produce.
    // We compute it the same way the production code does — `crypto`
    // SHA-256 of `name@range` lines sorted alphabetically.
    const crypto = await import('node:crypto')
    const expectedHash = crypto.createHash('sha256').update('better-sqlite3@^12.8.0').digest('hex')
    fs.writeFileSync(path.join(tmpDir, '.camstack-native-deps-installed'), expectedHash)

    await installManifestNativeDeps(tmpDir, declaration, noopLogger)
    // Marker matched → no install attempted, no info log.
    expect(noopLogger.info).not.toHaveBeenCalled()
    expect(noopLogger.debug).toHaveBeenCalledWith(
      'Native deps already installed (marker matches)',
      expect.any(Object),
    )
  })

  it('canonicalizes dep order so key reordering does not trigger re-install', async () => {
    const crypto = await import('node:crypto')
    // Hash for the canonical (alphabetical) form of two deps.
    const expectedHash = crypto
      .createHash('sha256')
      .update('better-sqlite3@^12.8.0\nsharp@^0.34.0')
      .digest('hex')
    fs.writeFileSync(path.join(tmpDir, '.camstack-native-deps-installed'), expectedHash)

    // Pass them in REVERSE order — the canonical hash should still match.
    await installManifestNativeDeps(
      tmpDir,
      {
        name: 'foo',
        camstack: {
          nativeDependencies: {
            sharp: '^0.34.0',
            'better-sqlite3': '^12.8.0',
          },
        },
      },
      noopLogger,
    )
    expect(noopLogger.debug).toHaveBeenCalledWith(
      'Native deps already installed (marker matches)',
      expect.any(Object),
    )
  })

  it('drops malformed (non-string) values silently', async () => {
    // null/undefined/number values get dropped. With ALL values bad,
    // the resulting set is empty so the function exits as a no-op.
    await installManifestNativeDeps(
      tmpDir,
      {
        name: 'foo',
        camstack: {
          nativeDependencies: { 'bad-dep': null, 'also-bad': 42 },
        },
      },
      noopLogger,
    )
    expect(noopLogger.info).not.toHaveBeenCalled()
  })
})
