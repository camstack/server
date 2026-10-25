import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyDeployedBundle } from '../agent-deploy-swap.js'
import type { IScopedLogger } from '@camstack/types'

const noopLogger: IScopedLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return noopLogger
  },
  withTags() {
    return noopLogger
  },
}

describe('applyDeployedBundle', () => {
  it('atomically swaps the new bundle into the live dir', async () => {
    const addonsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-deploy-'))
    const live = path.join(addonsDir, 'onvif')
    fs.mkdirSync(live, { recursive: true })
    fs.writeFileSync(
      path.join(live, 'package.json'),
      JSON.stringify({ name: 'onvif', version: '1.0.0' }),
    )

    const res = await applyDeployedBundle({
      addonsDir,
      addonId: 'onvif',
      bundle: Buffer.from('x'),
      extract: async (_tgz, dest) => {
        fs.writeFileSync(
          path.join(dest, 'package.json'),
          JSON.stringify({ name: 'onvif', version: '1.0.3' }),
        )
      },
      logger: noopLogger,
    })

    expect(res.addonDir).toBe(live)
    expect(JSON.parse(fs.readFileSync(path.join(live, 'package.json'), 'utf8')).version).toBe(
      '1.0.3',
    )
  })

  it('installs into a fresh addonsDir when no live dir exists yet', async () => {
    const addonsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-deploy-'))
    const live = path.join(addonsDir, 'onvif')

    await applyDeployedBundle({
      addonsDir,
      addonId: 'onvif',
      bundle: Buffer.from('x'),
      extract: async (_tgz, dest) => {
        fs.writeFileSync(
          path.join(dest, 'package.json'),
          JSON.stringify({ name: 'onvif', version: '2.0.0' }),
        )
      },
      logger: noopLogger,
    })

    expect(JSON.parse(fs.readFileSync(path.join(live, 'package.json'), 'utf8')).version).toBe(
      '2.0.0',
    )
  })

  it('leaves the old live dir intact when extract fails (no missing dir)', async () => {
    const addonsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-deploy-'))
    const live = path.join(addonsDir, 'onvif')
    fs.mkdirSync(live, { recursive: true })
    fs.writeFileSync(
      path.join(live, 'package.json'),
      JSON.stringify({ name: 'onvif', version: '1.0.0' }),
    )

    await expect(
      applyDeployedBundle({
        addonsDir,
        addonId: 'onvif',
        bundle: Buffer.from('x'),
        extract: async () => {
          throw new Error('killed untar')
        },
        logger: noopLogger,
      }),
    ).rejects.toThrow()

    expect(fs.existsSync(live)).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(live, 'package.json'), 'utf8')).version).toBe(
      '1.0.0',
    )
  })

  it('handles a scoped package name (slash in addonId) without nesting temp dirs', async () => {
    const addonsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-deploy-'))
    const live = path.join(addonsDir, '@camstack', 'addon-pipeline')
    fs.mkdirSync(live, { recursive: true })
    fs.writeFileSync(
      path.join(live, 'package.json'),
      JSON.stringify({ name: '@camstack/addon-pipeline', version: '1.0.0' }),
    )

    await applyDeployedBundle({
      addonsDir,
      addonId: '@camstack/addon-pipeline',
      bundle: Buffer.from('x'),
      extract: async (_tgz, dest) => {
        fs.writeFileSync(
          path.join(dest, 'package.json'),
          JSON.stringify({ name: '@camstack/addon-pipeline', version: '1.0.4' }),
        )
      },
      logger: noopLogger,
    })

    expect(JSON.parse(fs.readFileSync(path.join(live, 'package.json'), 'utf8')).version).toBe(
      '1.0.4',
    )
    // No stray temp/backup dirs left under the @camstack scope dir.
    const scopeEntries = fs.readdirSync(path.join(addonsDir, '@camstack'))
    expect(scopeEntries.filter((n) => n.startsWith('.addon-pipeline'))).toEqual([])
  })

  it('does not leave staging/backup detritus in addonsDir on success', async () => {
    const addonsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-deploy-'))
    const live = path.join(addonsDir, 'onvif')
    fs.mkdirSync(live, { recursive: true })
    fs.writeFileSync(
      path.join(live, 'package.json'),
      JSON.stringify({ name: 'onvif', version: '1.0.0' }),
    )

    await applyDeployedBundle({
      addonsDir,
      addonId: 'onvif',
      bundle: Buffer.from('x'),
      extract: async (_tgz, dest) => {
        fs.writeFileSync(
          path.join(dest, 'package.json'),
          JSON.stringify({ name: 'onvif', version: '1.0.3' }),
        )
      },
      logger: noopLogger,
    })

    const leftovers = fs.readdirSync(addonsDir).filter((n) => n.startsWith('.onvif.next'))
    expect(leftovers).toEqual([])
  })
})
