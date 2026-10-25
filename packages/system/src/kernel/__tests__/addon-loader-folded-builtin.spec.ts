/**
 * A package folded into the framework must not come back from the addons dir.
 *
 * `device-history` was a standalone package (`@camstack/addon-device-history`)
 * until it was folded into `@camstack/system` (2026-10-20). Every node that had
 * installed it still held `/data/addons/@camstack/addon-device-history@0.1.4`,
 * and the hub loads the closure's builtins FIRST and the addons dir AFTER — so
 * the stale package's `device-history` silently replaced the builtin of the
 * same id. Prod and the dev hub both ran 0.1.4: no `queryMany`, a node read
 * that still took `nodeId` (so every `listNodeSeries({ forNodeId })` answered
 * `[]`), and the pre-slack rate door.
 *
 * The rule: an addon id is owned by the first PACKAGE that registered it; a
 * different package claiming the same id is refused by name. A reload of the
 * SAME package still replaces it (redeploys depend on that).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { AddonLoader } from '../addon-loader.js'

interface Line {
  readonly message: string
  readonly extras: LogExtras
}

function recordingLogger(warns: Line[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn: (message, extras) => {
      warns.push({ message, extras: extras ?? {} })
    },
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

let tmpRoot: string

function writePackage(dir: string, packageName: string, version: string, marker: string): string {
  const pkgDir = path.join(tmpRoot, dir)
  fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({
      name: packageName,
      version,
      camstack: {
        addons: [{ id: 'device-history', entry: './dist/addon.mjs' }],
      },
    }),
  )
  fs.writeFileSync(
    path.join(pkgDir, 'dist', 'addon.mjs'),
    `export default class A { static marker = ${JSON.stringify(marker)}; async initialize() {} async shutdown() {} }\n`,
  )
  return pkgDir
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-folded-'))
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('an addon id folded into the framework', () => {
  it('stays the framework builtin when a stale package of another name declares it', async () => {
    const warns: Line[] = []
    const loader = new AddonLoader(recordingLogger(warns))
    const closure = writePackage('closure-system', '@camstack/system', '1.2.459', 'builtin')
    const addonsDir = path.join(tmpRoot, 'addons')
    fs.mkdirSync(path.join(addonsDir, '@camstack'), { recursive: true })
    fs.renameSync(
      writePackage('stale', '@camstack/addon-device-history', '0.1.4', 'stale'),
      path.join(addonsDir, '@camstack', 'addon-device-history'),
    )

    // The hub's boot order: closure builtins first, then the addons dir.
    await loader.loadFromAddonDir(closure)
    await loader.loadFromDirectory(addonsDir, ['@camstack/system'])

    const registered = loader.listAddons().find((a) => a.declaration.id === 'device-history')
    expect(registered?.packageName).toBe('@camstack/system')
    expect(registered?.packageVersion).toBe('1.2.459')
    const shadow = warns.find((w) => w.message.includes('already provided by'))
    expect(shadow?.extras.tags?.['addonId']).toBe('device-history')
    expect(JSON.stringify(shadow?.extras.meta)).toContain('@camstack/addon-device-history')
  })

  it('a reload of the SAME package still replaces it', async () => {
    const loader = new AddonLoader()
    await loader.loadFromAddonDir(writePackage('v1', '@camstack/system', '1.2.458', 'old'))
    await loader.loadFromAddonDir(writePackage('v2', '@camstack/system', '1.2.459', 'new'))
    const registered = loader.listAddons().find((a) => a.declaration.id === 'device-history')
    expect(registered?.packageVersion).toBe('1.2.459')
  })
})
