import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLazyUiServing, type StaticUiProvider } from '../ui-serving/lazy-ui-serving.js'

const dirs: string[] = []
const makeDist = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-ui-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>')
  dirs.push(dir)
  return dir
}
interface CountingProvider extends StaticUiProvider {
  calls: number
}
const providerFor = (staticDir: string): CountingProvider => {
  const p: CountingProvider = {
    calls: 0,
    getStaticDir: async () => {
      p.calls += 1
      return { staticDir }
    },
    getVersion: async () => ({ version: '1.0.0' }),
  }
  return p
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('createLazyUiServing', () => {
  it('serves a provider that registers after the boot window on the next request', async () => {
    let clock = 0
    let current: StaticUiProvider | null = null
    const dist = makeDist()
    const ui = createLazyUiServing({
      label: 'Viewer UI',
      lookup: () => current,
      log: () => {},
      now: () => clock,
    })
    expect(await ui.get()).toBeNull()
    current = providerFor(dist)
    clock += 2_500
    expect((await ui.get())?.staticDir).toBe(dist)
  })

  it('does not hammer: a burst while unresolved is one attempt and one log line', async () => {
    const lookup = vi.fn<() => StaticUiProvider | null>(() => null)
    const log = vi.fn()
    const ui = createLazyUiServing({
      label: 'Viewer UI',
      lookup,
      log,
      now: () => 0,
    })
    await Promise.all(Array.from({ length: 20 }, () => ui.get()))
    for (let i = 0; i < 5; i += 1) await ui.get()
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('asks the provider once for a burst of concurrent requests', async () => {
    const provider = providerFor(makeDist())
    const ui = createLazyUiServing({
      label: 'Viewer UI',
      lookup: () => provider,
      log: () => {},
      now: () => 0,
    })
    await Promise.all(Array.from({ length: 20 }, () => ui.get()))
    expect(provider.calls).toBe(1)
  })

  it('follows a provider that re-registers with a new staticDir', async () => {
    let clock = 0
    const first = makeDist()
    const second = makeDist()
    let current: StaticUiProvider = providerFor(first)
    const ui = createLazyUiServing({
      label: 'Viewer UI',
      lookup: () => current,
      log: () => {},
      now: () => clock,
    })
    expect((await ui.get())?.staticDir).toBe(first)
    current = providerFor(second)
    clock += 2_500
    expect((await ui.get())?.staticDir).toBe(second)
  })

  it('a re-registered provider whose getVersion fails is still followed, not left on the old dir', async () => {
    let clock = 0
    const first = makeDist()
    const second = makeDist()
    let current: StaticUiProvider = providerFor(first)
    const ui = createLazyUiServing({
      label: 'Viewer UI',
      lookup: () => current,
      log: () => {},
      now: () => clock,
    })
    expect((await ui.get())?.staticDir).toBe(first)
    current = {
      getStaticDir: async () => ({ staticDir: second }),
      getVersion: async () => {
        throw new Error('runner restarting')
      },
    }
    clock += 2_500
    expect((await ui.get())?.staticDir).toBe(second)
  })

  it('a hung provider RPC answers within the request wait instead of hanging the request', async () => {
    const hung: StaticUiProvider = {
      getStaticDir: () => new Promise(() => {}),
      getVersion: async () => ({ version: '1.0.0' }),
    }
    const ui = createLazyUiServing({
      label: 'Viewer UI',
      lookup: () => hung,
      log: () => {},
      requestWaitMs: 20,
      now: () => 0,
    })
    expect(await ui.get()).toBeNull()
    expect(await ui.get()).toBeNull()
  })
})
