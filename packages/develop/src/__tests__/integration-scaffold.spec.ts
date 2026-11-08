import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INTEGRATION_NOTES, scaffoldAddon } from '../scaffold/addon.js'
import { SCAFFOLD_KINDS, isScaffoldKind, type ScaffoldKind } from '../types.js'
import { validateAddon } from '../validate/addon.js'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const INTEGRATION_CAPS = [
  'device-provider',
  'device-adoption',
  'device-removal-hook',
  'device-export',
  'integration-instances',
] as const

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-develop-integration-'))
  tmpDirs.push(root)
  fs.mkdirSync(path.join(root, 'packages', 'types', 'src', 'capabilities'), { recursive: true })
  fs.mkdirSync(path.join(root, 'tools', 'build'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'camstack', private: true, workspaces: ['packages/*'] }),
    'utf8',
  )
  for (const name of INTEGRATION_CAPS) {
    fs.writeFileSync(
      path.join(root, 'packages', 'types', 'src', 'capabilities', `${name}.cap.ts`),
      `export const cap = {\n  name: '${name}',\n  scope: 'system',\n  mode: 'collection',\n  methods: {},\n} as const\n`,
      'utf8',
    )
  }
  return root
}

interface Manifest {
  readonly camstack: {
    readonly addons: readonly {
      readonly integrationRole?: string
      readonly instanceMode?: string
      readonly capabilities: readonly { readonly name: string }[]
    }[]
  }
}

function scaffold(kind: ScaffoldKind): {
  readonly root: string
  readonly manifest: Manifest
  readonly sources: ReadonlyMap<string, string>
} {
  const root = makeWorkspace()
  const result = scaffoldAddon({ workspaceRoot: root, name: 'probe-thing', kind })
  const manifest = JSON.parse(
    fs.readFileSync(path.join(result.packageDir, 'package.json'), 'utf8'),
  ) as Manifest
  const sources = new Map<string, string>()
  for (const file of result.contents ?? []) sources.set(file.path, file.content)
  return { root, manifest, sources }
}

/** The generated code and manifest; DEVELOP.md names the retired mechanisms on purpose. */
function allText(sources: ReadonlyMap<string, string>): string {
  return [...sources.entries()]
    .filter(([file]) => !file.endsWith('DEVELOP.md'))
    .map(([, content]) => content)
    .join('\n')
}

describe('scaffold kinds', () => {
  it('lists the integration kinds and guards the names', () => {
    for (const kind of ['device-integration', 'service-integration', 'exporter']) {
      expect(SCAFFOLD_KINDS).toContain(kind)
      expect(isScaffoldKind(kind)).toBe(true)
    }
    expect(isScaffoldKind('integration')).toBe(false)
  })

  it('no kind generates addon-level settings or the retired integration settings', () => {
    for (const kind of SCAFFOLD_KINDS) {
      const text = allText(scaffold(kind).sources)
      expect(text, kind).not.toContain('globalSettingsSchema')
      expect(text, kind).not.toContain('integration_settings')
      expect(text, kind).not.toMatch(/integrations\.(get|set)Settings/)
    }
  })
})

describe('scaffold teaches the scoped settings API (D986)', () => {
  it('the empty addon source names the scoped declaration', () => {
    const { sources } = scaffold('empty')
    const text = allText(sources)
    expect(text).toContain('scopedSettingsCapabilities()')
    expect(text).toContain('this.clusterSettings(cap')
  })

  it('the integration notes written into DEVELOP.md name the scoped API, not the retired hook', () => {
    const notes = INTEGRATION_NOTES.join('\n')
    expect(notes).toContain('clusterSettingsSchema(cap)')
    expect(notes).toContain('addonSettings.getScopedSettings')
    expect(notes).not.toContain('globalSettingsSchema')
    expect(notes).not.toContain('getGlobalSettings')
  })
})

describe('scaffold device-integration', () => {
  it('declares role devices, the instance caps, and validates', () => {
    const { root, manifest, sources } = scaffold('device-integration')
    const entry = manifest.camstack.addons[0]
    expect(entry?.integrationRole).toBe('devices')
    expect(entry?.instanceMode).toBe('multiple')
    expect(entry?.capabilities.map((c) => c.name)).toEqual([
      'device-provider',
      'integration-instances',
      'device-adoption',
      'device-removal-hook',
    ])
    const validation = validateAddon(root, 'probe-thing')
    expect(validation.findings.filter((f) => f.level === 'error')).toEqual([])
    expect(validation.ok).toBe(true)

    const text = allText(sources)
    expect(text).toContain('RecordIntegrationInstances')
    expect(text).toContain('meta({ secret: true })')
    expect(text).toContain("type: 'password'")
    expect(text).toContain('test: ')
    expect(text).toContain('integrationId')
    expect(text).toContain('deviceRemovalHookCapability')
    expect(text).toContain('DeviceType.Gateway')
  })

  it('adopts the Gateway as a top-level sibling, never a parent', () => {
    const text = allText(scaffold('device-integration').sources)
    // devices.create(stableId, Class, config, parent = null, meta)
    expect(text.match(/devices\.create\(\s*stableId,[^)]*?config,\s*null,/gs)?.length).toBe(2)
    expect(text).not.toMatch(/parentDeviceId:\s*[a-z]*[Gg]ateway/)
  })
})

describe('scaffold service-integration', () => {
  it('declares role services with a typed connection, a secret and a test', () => {
    const { root, manifest, sources } = scaffold('service-integration')
    const entry = manifest.camstack.addons[0]
    expect(entry?.integrationRole).toBe('services')
    expect(entry?.capabilities.map((c) => c.name)).toEqual(['integration-instances'])
    expect(validateAddon(root, 'probe-thing').ok).toBe(true)

    const text = allText(sources)
    expect(text).toContain("role: 'services'")
    expect(text).toContain('meta({ secret: true })')
    expect(text).toContain('canTest: true')
    expect(text).not.toContain('BaseDeviceProvider')
  })
})

describe('scaffold exporter', () => {
  it('declares device-export + integration-instances, multiple, minted ids, action button', () => {
    const { root, manifest, sources } = scaffold('exporter')
    const entry = manifest.camstack.addons[0]
    expect(entry?.instanceMode).toBe('multiple')
    expect(entry?.capabilities.map((c) => c.name)).toEqual([
      'device-export',
      'integration-instances',
    ])
    expect(validateAddon(root, 'probe-thing').ok).toBe(true)

    const text = allText(sources)
    expect(text).toContain('mintId')
    expect(text).toContain("type: 'addon-action-button'")
    expect(text).toContain('ExportInstanceUnknownError')
    // Exposure is keyed by the instance id: a membership write names the target.
    expect(text).toContain('patch(instanceId')
  })

  it('mints ids that never reuse an existing one', async () => {
    const root = makeWorkspace()
    const result = scaffoldAddon({ workspaceRoot: root, name: 'probe-thing', kind: 'exporter' })
    const file = path.join(result.packageDir, 'src', 'probe-thing-instances.ts')
    expect(fs.readFileSync(file, 'utf8')).toContain('padStart(3')
  })
})

describe('scaffolded providers declare their kinds (D1013)', () => {
  it.each([
    ['device-integration', "functionCap: 'device-provider'"],
    ['service-integration', "functionCap: 'integration-instances'"],
    ['exporter', "functionCap: 'device-export'"],
  ] as const)('%s emits a one-entry kinds[] in describe()', (kind, functionCap) => {
    const text = allText(scaffold(kind).sources)
    expect(text).toMatch(/kinds:\s*\[\s*\{[^\]]*id:/)
    expect(text).toContain(functionCap)
  })

  it('the exporter keeps kindOf and names the same id in kinds[]', () => {
    const text = allText(scaffold('exporter').sources)
    expect(text).toContain('kindOf: () =>')
    expect(text).toMatch(/kinds:\s*\[\{ id: \w+_TARGET_KIND,/)
  })
})
