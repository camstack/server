/**
 * The display palette is a cluster setting the orchestrator owns (D940).
 * An unreadable store is `unknown`, never the bundled preset. A refusal
 * names the pairs. The palette is one key in the orchestrator's store, so
 * a sibling settings key survives a write.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  type AddonStoreRead,
  bundledCamstack,
  PaletteRejectedError,
  type StoredKeyRead,
  type IScopedLogger,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  DISPLAY_PALETTE_STORE_KEY,
  createDisplayPaletteProvider,
  type DisplayPaletteSettings,
} from '../display-palette-provider.js'

function silentLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Memory {
  readonly settings: DisplayPaletteSettings
  readonly snapshot: () => Readonly<Record<string, unknown>>
}

function memory(initial: Readonly<Record<string, unknown>>, mode: 'ok' | 'fail' | 'throw'): Memory {
  let blob: Record<string, unknown> = { ...initial }
  const settings: DisplayPaletteSettings = {
    readAddonStoreKeyResult: async (key: string): Promise<StoredKeyRead> => {
      if (mode === 'throw') throw new Error('disk')
      if (mode === 'fail') {
        return { kind: 'unreadable', reason: 'store-read-failed', error: 'sqlite locked' }
      }
      return key in blob ? { kind: 'present', value: blob[key] } : { kind: 'absent' }
    },
    readAddonStoreResult: async (): Promise<AddonStoreRead> => {
      if (mode === 'throw') throw new Error('disk')
      if (mode === 'fail') return { kind: 'failed', error: 'sqlite locked' }
      if (Object.keys(blob).length === 0) return { kind: 'missing' }
      return { kind: 'value', value: { ...blob } }
    },
    writeAddonStore: async (patch) => {
      blob = { ...blob, ...patch }
    },
  }
  return { settings, snapshot: () => ({ ...blob }) }
}

describe('display palette provider', () => {
  it('serves the bundled preset when the key was never written, and lists presets', async () => {
    const store = memory({ nodeBindings: { a: 1 } }, 'ok')
    const provider = createDisplayPaletteProvider(store.settings, silentLogger())
    const palette = await provider.getPalette()
    expect(palette).toEqual(bundledCamstack())
    const presets = await provider.listPresets()
    expect(presets.map((row) => row.id)).toEqual(['camstack', 'high-contrast', 'okabe-ito'])
    expect(store.snapshot()).toEqual({ nodeBindings: { a: 1 } })
  })

  it('stores a preset under its own key and leaves sibling keys in place', async () => {
    const store = memory({ nodeBindings: { a: 1 } }, 'ok')
    const provider = createDisplayPaletteProvider(store.settings, silentLogger())
    const written = await provider.setPalette({ presetId: 'high-contrast' })
    expect(written).toMatchObject({ status: 'ready', presetId: 'high-contrast', source: 'stored' })
    expect(await provider.getPalette()).toEqual(written)
    const saved = store.snapshot()
    expect(saved.nodeBindings).toEqual({ a: 1 })
    expect(saved[DISPLAY_PALETTE_STORE_KEY]).toEqual({ presetId: 'high-contrast', overrides: {} })
  })

  it('reports unknown when the store cannot be read, not the bundled preset', async () => {
    const failed = createDisplayPaletteProvider(memory({}, 'fail').settings, silentLogger())
    const unread = await failed.getPalette()
    expect(unread.status).toBe('unknown')
    expect(unread).not.toEqual(bundledCamstack())

    const thrown = createDisplayPaletteProvider(memory({}, 'throw').settings, silentLogger())
    const blew = await thrown.getPalette()
    expect(blew.status).toBe('unknown')
    if (blew.status === 'unknown') expect(blew.reason).toContain('failed')

    const missing = createDisplayPaletteProvider(undefined, silentLogger())
    const none = await missing.getPalette()
    expect(none).toEqual({ status: 'unknown', reason: 'settings store cannot be read' })
  })

  it('refuses a close pair by name and does not write', async () => {
    const person = bundledCamstack().swatches.person
    if (person === undefined) throw new Error('person missing')
    const store = memory({ nodeBindings: { a: 1 } }, 'ok')
    const provider = createDisplayPaletteProvider(store.settings, silentLogger())
    await expect(
      provider.setPalette({ presetId: 'camstack', overrides: { vehicle: person } }),
    ).rejects.toBeInstanceOf(PaletteRejectedError)
    try {
      await provider.setPalette({ presetId: 'camstack', overrides: { vehicle: person } })
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(PaletteRejectedError)
      if (err instanceof PaletteRejectedError) {
        expect(err.message).toContain('person')
        expect(err.message).toContain('vehicle')
      }
    }
    expect(store.snapshot()).toEqual({ nodeBindings: { a: 1 } })
  })

  it('reads the palette key out of a store that already holds other settings', async () => {
    const store = memory({ nodeBindings: { a: 1 }, presetId: 'not-a-palette' }, 'ok')
    const provider = createDisplayPaletteProvider(
      {
        readAddonStoreResult: store.settings.readAddonStoreResult,
        writeAddonStore: store.settings.writeAddonStore,
      },
      silentLogger(),
    )
    expect(await provider.getPalette()).toEqual(bundledCamstack())
  })
})

describe('display-palette manifest', () => {
  it('is declared by the pipeline orchestrator and not by a system builtin', () => {
    const root = path.resolve(import.meta.dirname, '../../../..')
    const orchestrator = JSON.parse(
      readFileSync(path.join(root, 'packages/addon-pipeline-orchestrator/package.json'), 'utf8'),
    ) as {
      readonly camstack: {
        readonly addons: readonly {
          readonly id: string
          readonly capabilities?: readonly { readonly name: string }[]
        }[]
      }
    }
    const system = JSON.parse(
      readFileSync(path.join(root, 'packages/system/package.json'), 'utf8'),
    ) as {
      readonly camstack: { readonly addons: readonly { readonly id: string }[] }
    }
    const entry = orchestrator.camstack.addons.find((addon) => addon.id === 'pipeline-orchestrator')
    if (entry === undefined) throw new Error('pipeline-orchestrator missing')
    expect((entry.capabilities ?? []).map((cap) => cap.name)).toContain('display-palette')
    expect(system.camstack.addons.some((addon) => addon.id === 'display-palette')).toBe(false)
  })
})
