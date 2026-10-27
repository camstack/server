import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scaffoldAddon } from '../scaffold/addon.js'
import { scaffoldCapStub } from '../scaffold/cap-stub.js'
import { extendAddon } from '../scaffold/extend.js'
import { validateAddon } from '../validate/addon.js'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeFakeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-develop-'))
  tmpDirs.push(root)
  fs.mkdirSync(path.join(root, 'packages', 'types', 'src', 'capabilities'), { recursive: true })
  fs.mkdirSync(path.join(root, 'tools', 'build'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'camstack', private: true, workspaces: ['packages/*'] }),
    'utf8',
  )
  fs.writeFileSync(
    path.join(root, 'packages', 'types', 'src', 'capabilities', 'smtp-provider.cap.ts'),
    `export const smtpProviderCapability = {
  name: 'smtp-provider',
  scope: 'system',
  mode: 'collection',
  methods: {},
} as const
`,
    'utf8',
  )
  return root
}

describe('scaffoldAddon', () => {
  it('writes package + vite entries + addon source', () => {
    const root = makeFakeWorkspace()
    const result = scaffoldAddon({
      workspaceRoot: root,
      name: 'weather-station',
      displayName: 'Weather Station',
      kind: 'provider',
    })

    expect(result.relativeDir).toBe('packages/addon-weather-station')
    const pkgPath = path.join(result.packageDir, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      camstack: { addons: { id: string; entry: string }[] }
    }
    expect(pkg.camstack.addons[0]?.id).toBe('weather-station')
    expect(pkg.camstack.addons[0]?.entry).toBe('./dist/weather-station.addon.js')

    const vite = fs.readFileSync(path.join(result.packageDir, 'vite.config.ts'), 'utf8')
    expect(vite).toContain("'weather-station.addon'")
    expect(fs.existsSync(path.join(result.packageDir, 'src', 'weather-station.addon.ts'))).toBe(
      true,
    )
    expect(fs.existsSync(path.join(result.packageDir, 'DEVELOP.md'))).toBe(true)

    const validation = validateAddon(root, 'weather-station')
    expect(validation.ok).toBe(true)
  })

  it('emits a README with the generated block and a CHANGELOG with [Unreleased], both packed', () => {
    const root = makeFakeWorkspace()
    const result = scaffoldAddon({
      workspaceRoot: root,
      name: 'docs-check',
      displayName: 'Docs Check',
    })
    const readme = fs.readFileSync(path.join(result.packageDir, 'README.md'), 'utf8')
    expect(readme).toContain('# Docs Check')
    expect(readme).toContain('<!-- readme:generated:start')
    expect(readme).toContain('<!-- readme:generated:end -->')
    const changelog = fs.readFileSync(path.join(result.packageDir, 'CHANGELOG.md'), 'utf8')
    expect(changelog).toContain('## [Unreleased]')
    expect(changelog).toMatch(/### Added\n\n- Initial release\./)
    const pkg = JSON.parse(
      fs.readFileSync(path.join(result.packageDir, 'package.json'), 'utf8'),
    ) as {
      files: string[]
    }
    expect(pkg.files).toEqual(['dist', 'README.md', 'CHANGELOG.md'])
  })

  // D777: the capability toggle is an addon's ONE enable. A scaffolded
  // private `enabled` "master switch" is a second one that nothing reads.
  it('the addon source declares no `enabled` master switch', () => {
    const root = makeFakeWorkspace()
    const result = scaffoldAddon({ workspaceRoot: root, name: 'no-switch', kind: 'provider' })
    const source = fs.readFileSync(
      path.join(result.packageDir, 'src', 'no-switch.addon.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/\benabled\b/)
    expect(source).not.toMatch(/master switch/i)
  })

  it('an extended entry declares no `enabled` field either', () => {
    const root = makeFakeWorkspace()
    const base = scaffoldAddon({ workspaceRoot: root, name: 'multi', kind: 'provider' })
    extendAddon({ workspaceRoot: root, addon: 'multi', entryId: 'second-entry' })
    const source = fs.readFileSync(
      path.join(base.packageDir, 'src', 'second-entry.addon.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/\benabled\b/)
  })

  it('dryRun does not create files', () => {
    const root = makeFakeWorkspace()
    const result = scaffoldAddon({
      workspaceRoot: root,
      name: 'dry-run-demo',
      dryRun: true,
    })
    expect(result.filesWritten.length).toBeGreaterThan(0)
    expect(fs.existsSync(result.packageDir)).toBe(false)
  })
})

describe('scaffoldCapStub', () => {
  it('writes a *.cap.ts stub', () => {
    const root = makeFakeWorkspace()
    const result = scaffoldCapStub({
      workspaceRoot: root,
      name: 'widget-catalog',
      scope: 'system',
      mode: 'collection',
    })
    expect(result.relativePath).toBe('packages/types/src/capabilities/widget-catalog.cap.ts')
    const text = fs.readFileSync(result.filePath, 'utf8')
    expect(text).toContain("name: 'widget-catalog'")
    expect(text).toContain('widgetCatalogCapability')
  })
})
