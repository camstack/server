import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  copyDirRecursive,
  ensureDir,
  stripCamstackDeps,
  stripBundledDeps,
  copyExtraFileDirs,
} from '../fs-utils.js'

describe('ensureDir', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-fsutils-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates nested directories', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c')
    ensureDir(nested)
    expect(fs.existsSync(nested)).toBe(true)
  })

  it('is idempotent', () => {
    const dir = path.join(tmpDir, 'exists')
    ensureDir(dir)
    ensureDir(dir) // should not throw
    expect(fs.existsSync(dir)).toBe(true)
  })
})

describe('copyDirRecursive', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-fsutils-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('copies files and subdirectories', async () => {
    const src = path.join(tmpDir, 'src')
    const dest = path.join(tmpDir, 'dest')
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(src, 'a.txt'), 'hello')
    fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'world')

    await copyDirRecursive(src, dest)

    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf-8')).toBe('hello')
    expect(fs.readFileSync(path.join(dest, 'sub', 'b.txt'), 'utf-8')).toBe('world')
  })
})

describe('copyExtraFileDirs', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-fsutils-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('copies directories listed in files field', async () => {
    const src = path.join(tmpDir, 'src')
    const dest = path.join(tmpDir, 'dest')
    fs.mkdirSync(path.join(src, 'python'), { recursive: true })
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(src, 'python', 'script.py'), 'print("hi")')

    await copyExtraFileDirs({ files: ['dist', 'python'] }, src, dest)

    expect(fs.readFileSync(path.join(dest, 'python', 'script.py'), 'utf-8')).toBe('print("hi")')
    expect(fs.existsSync(path.join(dest, 'dist'))).toBe(false) // dist is skipped
  })

  it('handles package with no files field', async () => {
    const src = path.join(tmpDir, 'src')
    const dest = path.join(tmpDir, 'dest')
    fs.mkdirSync(src, { recursive: true })
    fs.mkdirSync(dest, { recursive: true })

    // Should not throw
    await copyExtraFileDirs({ name: 'test' }, src, dest)
  })
})

describe('stripBundledDeps', () => {
  const basePkg = {
    name: '@camstack/addon-provider-reolink',
    version: '1.0.0',
    dependencies: {
      '@camstack/types': '*',
      '@apocaliss92/nodelink-js': '^0.4.24',
      'lucide-react': '^0.4.0',
      zod: '^4.0.0',
    },
    devDependencies: { vitest: '^3.0.0' },
  }

  it('strips every bundled JS dep — the dist is self-contained', () => {
    const result = stripBundledDeps(basePkg)
    expect(result.dependencies).toBeUndefined()
    expect(result.devDependencies).toBeUndefined()
  })

  it('drops host-external natives — they resolve from the framework, not a per-addon install', () => {
    // node-av/sharp/node-pty are HOST-EXTERNAL (resolved from the framework
    // closure); better-sqlite3 is hub-only. With RUNTIME_NATIVE_KEEP empty, a
    // self-contained addon keeps NONE of them → no per-addon node_modules, so
    // `addons/` stays node_modules-free for the whole-folder backup (ADR-0027).
    const pkg = {
      ...basePkg,
      name: '@camstack/addon-post-analysis',
      dependencies: {
        '@camstack/types': '*',
        'node-av': '^6.0.0',
        'better-sqlite3': '^11.0.0',
        sharp: '^0.35.0',
        '@tanstack/react-query': '^5.0.0',
      },
    }
    const result = stripBundledDeps(pkg)
    expect(result.dependencies).toBeUndefined()
  })

  it('keeps deps named in camstack.runtimeDependencies (version from the manifest)', () => {
    const pkg = {
      ...basePkg,
      camstack: { runtimeDependencies: ['zod'] },
    }
    const result = stripBundledDeps(pkg)
    expect(result.dependencies).toEqual({ zod: '^4.0.0' })
  })

  it('folds a kept peer dep into dependencies so --omit=peer cannot drop it', () => {
    // Only camstack.runtimeDependencies is kept now (RUNTIME_NATIVE_KEEP is
    // empty); a kept dep declared as a PEER must still fold into dependencies.
    const pkg = {
      name: '@camstack/addon-pipeline',
      version: '1.0.0',
      camstack: { runtimeDependencies: ['some-runtime-lib'] },
      dependencies: { 'lucide-react': '^0.4.0' },
      peerDependencies: { 'some-runtime-lib': '^1.2.3' },
    }
    const result = stripBundledDeps(pkg)
    expect(result.dependencies).toEqual({ 'some-runtime-lib': '^1.2.3' })
    expect(result.peerDependencies).toBeUndefined()
  })

  it('never keeps @camstack/* even when listed in runtimeDependencies', () => {
    const pkg = {
      ...basePkg,
      camstack: { runtimeDependencies: ['@camstack/types', 'zod'] },
    }
    const result = stripBundledDeps(pkg)
    expect(result.dependencies).toEqual({ zod: '^4.0.0' })
  })

  it('system packages (camstack.system: true) keep the legacy strip — they are not self-contained bundles', () => {
    const pkg = {
      name: '@camstack/core',
      version: '1.0.0',
      camstack: { system: true },
      dependencies: { '@camstack/types': '*', 'better-sqlite3': '^11.0.0', yaml: '^2.0.0' },
    }
    const result = stripBundledDeps(pkg)
    expect(result.dependencies).toEqual({ 'better-sqlite3': '^11.0.0', yaml: '^2.0.0' })
  })
})

describe('stripCamstackDeps', () => {
  it('removes @camstack/* dependencies', () => {
    const pkg = {
      name: '@camstack/addon-motion-detection',
      version: '0.1.0',
      dependencies: {
        '@camstack/types': '^0.1.0',
        '@camstack/system': '^0.1.0',
        lodash: '^4.17.21',
      },
      devDependencies: {
        vitest: '^3.0.0',
      },
    }

    const result = stripCamstackDeps(pkg)

    expect(result.dependencies).toEqual({ lodash: '^4.17.21' })
    expect(result.devDependencies).toBeUndefined() // devDeps always stripped
    expect(result.name).toBe('@camstack/addon-motion-detection')
  })

  it('handles package with no dependencies', () => {
    const pkg = { name: 'test', version: '1.0.0' }
    const result = stripCamstackDeps(pkg)
    expect(result.dependencies).toBeUndefined()
  })

  it('strips peerDependencies with @camstack scope', () => {
    const pkg = {
      name: 'test',
      version: '1.0.0',
      peerDependencies: {
        '@camstack/kernel': '^0.1.0',
        express: '^4.0.0',
      },
    }

    const result = stripCamstackDeps(pkg)
    expect(result.peerDependencies).toEqual({ express: '^4.0.0' })
  })

  // Contract: @camstack/shm-ring is a host-provided system package. The
  // addon-installer must strip every @camstack/* entry from an addon's
  // package.json before `npm install`, so these packages are never fetched
  // from npm and instead resolve from the host's node_modules (the installed
  // addon lives inside the host tree; Node's upward resolution finds them).
  // Regression guard: shm-ring must be stripped from dependencies AND
  // devDependencies (it was previously declared in addon-pipeline's
  // peerDependencies + devDependencies).
  it('strips @camstack/shm-ring while retaining non-camstack deps', () => {
    const pkg = {
      name: '@camstack/addon-pipeline',
      version: '0.1.0',
      dependencies: {
        '@camstack/shm-ring': '^0.1.0',
        '@camstack/system': '^0.1.0',
        lodash: '^4',
      },
      peerDependencies: {
        '@camstack/types': '^0.1.0',
      },
      devDependencies: {
        '@camstack/shm-ring': '*',
      },
    }

    const result = stripCamstackDeps(pkg)

    // dependencies: all @camstack/* removed, lodash retained.
    expect(result.dependencies).toEqual({ lodash: '^4' })

    // Explicit regression assertion: shm-ring is the package this test exists
    // to lock — it must not survive in dependencies.
    expect(result.dependencies).not.toHaveProperty('@camstack/shm-ring')

    // peerDependencies: only @camstack/types present, so the section collapses
    // to undefined once stripped.
    expect(result.peerDependencies).toBeUndefined()

    // devDependencies is always stripped wholesale by stripCamstackDeps,
    // so shm-ring there is removed along with the entire section.
    expect(result.devDependencies).toBeUndefined()

    // Non-stripped fields are preserved.
    expect(result.name).toBe('@camstack/addon-pipeline')
    expect(result.version).toBe('0.1.0')
  })
})
