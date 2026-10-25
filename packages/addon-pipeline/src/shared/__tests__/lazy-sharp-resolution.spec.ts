/**
 * What happens when `sharp` cannot be resolved AT ALL — the failure the subject
 * tile tier actually shipped into.
 *
 * The decode worker is a plain `child_process.fork` with no framework resolver
 * hook, so in it `import('sharp')` throws `Cannot find package 'sharp'`. Two
 * separate bugs came out of that, and this spec pins the fix for both:
 *
 *  1. nothing tried the explicit framework path, although `node-av` had been
 *     doing exactly that in the same file for months → the tier could never work;
 *  2. the memo was CLEARED on failure, so every subject of every frame re-entered
 *     the module loader (a synchronous `Atomics.wait` on the frame path) and
 *     logged a WARN — 3 800 WARN/min cluster-wide.
 *
 * So: the candidate ORDER, exactly ONE warning, and NO further resolution
 * attempts after the verdict. Remove either half of the fix in `lazy-sharp.ts`
 * (the fallback, or the sticky memo) and this file goes red.
 */
import { describe, expect, it, vi } from 'vitest'
import { hostExternalEntryUrls, isModuleResolutionError } from '../host-external-import.js'
import {
  createSharpLoader,
  type SharpFactory,
  type SharpModuleShape,
  SharpUnavailableError,
} from '../lazy-sharp.js'

/**
 * The REAL factory, used as the success payload. A hand-rolled stand-in cannot
 * satisfy `SharpFactory` without a cast, and this codebase forbids casts; the
 * spec only ever compares identity, so the real module costs one load and buys
 * a type-honest fixture.
 */
const realSharp: SharpFactory = (await import('sharp')).default

function notFound(specifier: string): Error {
  const err = new Error(`Cannot find package '${specifier}' imported from /data/addons/x/dist/y.js`)
  return Object.assign(err, { code: 'ERR_MODULE_NOT_FOUND' })
}

function dlopenFailed(): Error {
  return Object.assign(new Error('Could not load the sharp module'), {
    code: 'ERR_DLOPEN_FAILED',
  })
}

const FRAMEWORK_URL = 'file:///data/framework/node_modules/sharp/dist/index.cjs'
const BUNDLE_URL = 'file:///res/node_modules/sharp/dist/index.cjs'

describe('hostExternalEntryUrls', () => {
  it('offers the framework overlay, the electron bundle, its asar mirror, then the cwd', () => {
    const anchors: string[] = []
    const urls = hostExternalEntryUrls('sharp', {
      env: {
        CAMSTACK_FRAMEWORK_DIR: '/data/framework',
        CAMSTACK_BUNDLED_ADDONS_DIR: '/res/addons',
      },
      cwd: '/data/addons/@camstack/addon-pipeline',
      resolve: (anchorPath: string): string | null => {
        anchors.push(anchorPath)
        // Mirror a real layout: only the framework overlay and the plain bundle
        // have the package; the asar mirror and the addon dir do not.
        if (anchorPath.startsWith('/data/framework/'))
          return '/data/framework/node_modules/sharp/dist/index.cjs'
        if (anchorPath.startsWith('/res/node_modules/'))
          return '/res/node_modules/sharp/dist/index.cjs'
        return null
      },
    })
    expect(anchors).toEqual([
      '/data/framework/node_modules/__camstack_host_external_anchor__.cjs',
      '/res/node_modules/__camstack_host_external_anchor__.cjs',
      '/res/app.asar.unpacked/node_modules/__camstack_host_external_anchor__.cjs',
      '/data/addons/@camstack/addon-pipeline/__camstack_host_external_anchor__.cjs',
    ])
    expect(urls).toEqual([FRAMEWORK_URL, BUNDLE_URL])
  })

  it('finds the SAME electron Resources root when the seed dir is the closure scope dir', () => {
    // The packaged app stopped shipping a second `Resources/addons` tree
    // (2026-08-25) and now points `CAMSTACK_BUNDLED_ADDONS_DIR` at the closure's
    // own scope dir, `<resources>/node_modules/@camstack`. A `path.dirname` of
    // that is `<resources>/node_modules` — one level too deep — which would have
    // anchored at `<resources>/node_modules/node_modules` and silently lost
    // sharp/node-av in every forked decode worker on the desktop agent.
    const anchors: string[] = []
    const urls = hostExternalEntryUrls('sharp', {
      env: { CAMSTACK_BUNDLED_ADDONS_DIR: '/res/node_modules/@camstack' },
      cwd: '/data/addons/@camstack/addon-pipeline',
      resolve: (anchorPath: string): string | null => {
        anchors.push(anchorPath)
        return anchorPath.startsWith('/res/node_modules/__')
          ? '/res/node_modules/sharp/dist/index.cjs'
          : null
      },
    })
    expect(anchors).toEqual([
      '/res/node_modules/__camstack_host_external_anchor__.cjs',
      '/res/app.asar.unpacked/node_modules/__camstack_host_external_anchor__.cjs',
      '/data/addons/@camstack/addon-pipeline/__camstack_host_external_anchor__.cjs',
    ])
    expect(urls).toEqual([BUNDLE_URL])
  })

  it('still tries the cwd with neither env var set — that is where NODE_PATH is honoured', () => {
    const anchors: string[] = []
    const urls = hostExternalEntryUrls('sharp', {
      env: {},
      cwd: '/app',
      resolve: (anchorPath: string): string | null => {
        anchors.push(anchorPath)
        return '/framework/node_modules/sharp/dist/index.cjs'
      },
    })
    expect(anchors).toEqual(['/app/__camstack_host_external_anchor__.cjs'])
    expect(urls).toEqual(['file:///framework/node_modules/sharp/dist/index.cjs'])
  })

  it('is empty when nothing resolves — the bare specifier stays the only path', () => {
    expect(
      hostExternalEntryUrls('sharp', {
        env: {},
        cwd: '/app',
        resolve: () => null,
      }),
    ).toEqual([])
  })

  it('deduplicates anchors that resolve to the same file (a NODE_PATH hit)', () => {
    const urls = hostExternalEntryUrls('sharp', {
      env: { CAMSTACK_FRAMEWORK_DIR: '/data/framework' },
      cwd: '/app',
      resolve: () => '/data/framework/node_modules/sharp/dist/index.cjs',
    })
    expect(urls).toEqual([FRAMEWORK_URL])
  })

  it('classifies not-found as resolution and a native load failure as not', () => {
    expect(isModuleResolutionError(notFound('sharp'))).toBe(true)
    expect(isModuleResolutionError(dlopenFailed())).toBe(false)
  })
})

describe('createSharpLoader — resolution failure', () => {
  it('tries the bare specifier then every fallback, in order', async () => {
    const tried: string[] = []
    const loader = createSharpLoader({
      importModule: (specifier: string): Promise<SharpModuleShape> => {
        tried.push(specifier)
        return Promise.reject(notFound(specifier))
      },
      fallbackUrls: () => [FRAMEWORK_URL, BUNDLE_URL],
      warn: vi.fn(),
    })
    await expect(loader.load()).rejects.toBeInstanceOf(SharpUnavailableError)
    expect(tried).toEqual(['sharp', FRAMEWORK_URL, BUNDLE_URL])
  })

  it('warns ONCE and never resolves again — no retry on the next frame', async () => {
    const tried: string[] = []
    const warn = vi.fn()
    const loader = createSharpLoader({
      importModule: (specifier: string): Promise<SharpModuleShape> => {
        tried.push(specifier)
        return Promise.reject(notFound(specifier))
      },
      fallbackUrls: () => [FRAMEWORK_URL],
      warn,
    })

    await expect(loader.load()).rejects.toBeInstanceOf(SharpUnavailableError)
    const afterFirst = tried.length
    expect(afterFirst).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)

    // Twelve later subjects across later frames: the verdict is remembered, so
    // not one of them re-enters the module loader and not one of them logs.
    for (let i = 0; i < 12; i += 1) {
      await expect(loader.load()).rejects.toBeInstanceOf(SharpUnavailableError)
    }
    expect(tried).toHaveLength(afterFirst)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('names every candidate it tried, and the cause, in the single warning', async () => {
    const warn = vi.fn()
    const loader = createSharpLoader({
      importModule: (specifier: string): Promise<SharpModuleShape> =>
        Promise.reject(notFound(specifier)),
      fallbackUrls: () => [FRAMEWORK_URL],
      warn,
    })
    await expect(loader.load()).rejects.toThrow(SharpUnavailableError)
    const message = warn.mock.calls[0]?.[0]
    expect(message).toContain('sharp')
    expect(message).toContain(FRAMEWORK_URL)
    expect(message).toContain('Cannot find package')
  })
})

describe('createSharpLoader — success and the retryable case', () => {
  it('resolves through a fallback when the bare specifier does not, then memoizes', async () => {
    const factory = realSharp
    const tried: string[] = []
    const loader = createSharpLoader({
      importModule: (specifier: string): Promise<SharpModuleShape> => {
        tried.push(specifier)
        if (specifier === FRAMEWORK_URL) return Promise.resolve({ default: factory })
        return Promise.reject(notFound(specifier))
      },
      fallbackUrls: () => [FRAMEWORK_URL, BUNDLE_URL],
      warn: vi.fn(),
    })
    await expect(loader.load()).resolves.toBe(factory)
    await expect(loader.load()).resolves.toBe(factory)
    expect(tried).toEqual(['sharp', FRAMEWORK_URL])
  })

  it('shares ONE import between concurrent first callers', async () => {
    const factory = realSharp
    const tried: string[] = []
    const loader = createSharpLoader({
      importModule: (specifier: string): Promise<SharpModuleShape> => {
        tried.push(specifier)
        return Promise.resolve({ default: factory })
      },
      fallbackUrls: () => [],
      warn: vi.fn(),
    })
    await Promise.all([loader.load(), loader.load(), loader.load()])
    expect(tried).toEqual(['sharp'])
  })

  it('does NOT memoize a module that was FOUND and failed to load — a deploy blip retries', async () => {
    let attempts = 0
    const factory = realSharp
    const warn = vi.fn()
    const loader = createSharpLoader({
      importModule: (): Promise<SharpModuleShape> => {
        attempts += 1
        // A partially-unpacked native dep: present, unloadable, then fine.
        if (attempts === 1) return Promise.reject(dlopenFailed())
        return Promise.resolve({ default: factory })
      },
      fallbackUrls: () => [FRAMEWORK_URL],
      warn,
    })
    await expect(loader.load()).rejects.toThrow('Could not load the sharp module')
    // A load failure is not a verdict about where the module IS, so no fallback
    // is tried and nothing is declared unavailable.
    expect(attempts).toBe(1)
    expect(warn).not.toHaveBeenCalled()
    await expect(loader.load()).resolves.toBe(factory)
  })
})
