/**
 * Package README generation.
 *
 * A README has two kinds of text. The hand-written part (title, the paragraph
 * that says what the package is for, any notes the author adds) is never
 * touched once it exists. The derived part (what the package provides, the
 * settings an operator sets, where it runs, what it needs, which docs describe
 * it) lives between the two markers below and is rewritten from the manifest,
 * the settings labels in `i18n/en.json` and the frontmatter of the docs.
 *
 * `scripts/readme-generate.ts` writes; `scripts/check-readmes-current.ts`
 * fails when a derived block is stale.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { WorkspacePackage } from './workspace-packages'

export const GENERATED_START = '<!-- readme:generated:start (derived from the manifest; edit outside this block) -->'
export const GENERATED_END = '<!-- readme:generated:end -->'

const REPO_BLOB = 'https://github.com/camstack/server/blob/main'

/** Friendly names for packages that are not addons (no manifest display name). */
const FRAMEWORK_NAMES: Readonly<Record<string, string>> = {
  'packages/cli': 'CamStack CLI',
  'packages/desktop': 'CamStack Desktop',
  'packages/develop': 'CamStack Develop',
  'packages/mcp-dev': 'CamStack Dev MCP',
  'packages/mcp-develop': 'CamStack Develop MCP',
  'packages/node-root': 'Node Root',
  'packages/nx-plugin': 'CamStack Nx Plugin',
  'packages/sdk': 'CamStack SDK',
  'packages/system': 'CamStack System',
  'packages/types': 'CamStack Types',
  'packages/ui-library': 'CamStack UI Library',
  'packages/werift-turn-fix': 'werift TURN Fix',
  'server/backend': 'CamStack Server',
}

/** The first sentence for a package whose package.json has no description. */
const SEED_PROSE: Readonly<Record<string, string>> = {
  'packages/ui-library':
    'The shared React component library and Tailwind theme the CamStack admin UI, addon pages and widgets are built from.',
  'packages/sdk':
    'The client SDK for talking to a CamStack hub from your own code.',
  'server/backend':
    'The CamStack server: the hub and agent entry points and the closure of framework packages every node installs.',
}

interface ManifestAddon {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly description: string
  readonly capabilities: readonly string[]
  readonly placement: string
  readonly group: string
  readonly pythonRequirements: string
  readonly systemDependencies: readonly string[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function readAddons(pkg: WorkspacePackage): readonly ManifestAddon[] {
  const camstack = asRecord(pkg.manifest['camstack'])
  const addons = camstack['addons']
  if (!Array.isArray(addons)) return []
  return addons.map((raw: unknown): ManifestAddon => {
    const addon = asRecord(raw)
    const execution = asRecord(addon['execution'])
    const python = asRecord(addon['python'])
    const capabilities = Array.isArray(addon['capabilities']) ? addon['capabilities'] : []
    return {
      id: str(addon['id']),
      name: str(addon['name']) || str(addon['id']),
      category: str(addon['category']),
      description: str(addon['description']),
      capabilities: capabilities.map((cap: unknown) => str(asRecord(cap)['name'])).filter(Boolean),
      placement: str(execution['placement']),
      group: str(execution['group']),
      pythonRequirements: str(python['requirements']),
      systemDependencies: strings(addon['systemDependencies']),
    }
  })
}

export function friendlyName(pkg: WorkspacePackage): string {
  const fixed = FRAMEWORK_NAMES[pkg.dir]
  if (fixed !== undefined) return fixed
  const camstack = asRecord(pkg.manifest['camstack'])
  const display = str(camstack['displayName']) || str(asRecord(camstack['bundle'])['displayName'])
  if (display.length > 0) return display
  return readAddons(pkg)[0]?.name ?? pkg.name
}

function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/** The hand-written paragraph a new README starts with. */
export function seedProse(pkg: WorkspacePackage): string {
  const seed = SEED_PROSE[pkg.dir]
  if (seed !== undefined) return seed
  const camstack = asRecord(pkg.manifest['camstack'])
  const bundle = str(asRecord(camstack['bundle'])['description'])
  const parts = [pkg.description, bundle].filter((part) => part.length > 0)
  const unique = parts.filter((part, index) => parts.indexOf(part) === index)
  return unique.length > 0 ? unique.map(sentence).join(' ') : `${friendlyName(pkg)}.`
}

function humanize(slug: string): string {
  const spaced = slug.replace(/^s_/, '').replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const SETTINGS_FAMILIES: ReadonlyArray<{ readonly title: string; readonly match: (family: string) => boolean }> = [
  {
    title: 'Addon settings',
    match: (family) =>
      family === 'globalSettings' ||
      family === 'fullSettings' ||
      family === 'settingsUI' ||
      family === 'config' ||
      family.endsWith('Settings'),
  },
  { title: 'Connection', match: (family) => family === 'connection' },
  { title: 'Adding a device', match: (family) => family === 'creation' },
  { title: 'Per-device settings', match: (family) => family === 'schema' },
]

const MAX_SECTIONS = 8
const MAX_FIELDS = 8

interface SettingsGroup {
  readonly title: string
  readonly sections: ReadonlyMap<string, readonly string[]>
}

/** Section → field labels, per family, read from the package's English labels. */
export function settingsFromLabels(labels: Readonly<Record<string, unknown>>): readonly SettingsGroup[] {
  const groups: SettingsGroup[] = []
  for (const { title, match } of SETTINGS_FAMILIES) {
    const sectionTitles = new Map<string, string>()
    const fields = new Map<string, string[]>()
    for (const [key, value] of Object.entries(labels)) {
      if (typeof value !== 'string') continue
      const parts = key.split('.')
      const family = parts[0] ?? ''
      if (!match(family)) continue
      const section = parts[1] ?? ''
      if (parts.length === 3 && parts[2] === 'title') sectionTitles.set(section, value)
      if (parts.length === 4 && parts[3] === 'label' && section.startsWith('s_')) {
        const list = fields.get(section) ?? []
        if (!list.includes(value)) list.push(value)
        fields.set(section, list)
      }
    }
    if (fields.size === 0) continue
    const sections = new Map<string, readonly string[]>()
    for (const [section, list] of fields) {
      sections.set(sectionTitles.get(section) ?? humanize(section), list)
    }
    groups.push({ title, sections })
  }
  return groups
}

function readLabels(root: string, pkg: WorkspacePackage): Readonly<Record<string, unknown>> {
  const file = path.join(root, pkg.dir, 'i18n', 'en.json')
  if (!fs.existsSync(file)) return {}
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  return asRecord(parsed)
}

function renderSettings(groups: readonly SettingsGroup[]): readonly string[] {
  const lines: string[] = []
  for (const group of groups) {
    lines.push(`**${group.title}**`, '')
    const sections = [...group.sections].slice(0, MAX_SECTIONS)
    for (const [section, fields] of sections) {
      const shown = fields.slice(0, MAX_FIELDS).join(', ')
      const more = fields.length > MAX_FIELDS ? `, and ${fields.length - MAX_FIELDS} more` : ''
      lines.push(`- ${section}: ${shown}${more}`)
    }
    if (group.sections.size > MAX_SECTIONS) {
      lines.push(`- and ${group.sections.size - MAX_SECTIONS} more sections`)
    }
    lines.push('')
  }
  return lines
}

interface DocClaim {
  readonly file: string
  readonly patterns: readonly string[]
}

function frontmatterClaims(text: string): readonly string[] {
  const match = /^---\n([\s\S]*?)\n---/.exec(text)
  if (match === null) return []
  const claims: string[] = []
  let inList = false
  for (const line of (match[1] ?? '').split('\n')) {
    if (/^(covers|applies-to):\s*$/.test(line)) {
      inList = true
    } else if (/^\S/.test(line)) {
      inList = false
    } else if (inList) {
      const item = /^\s+-\s+(.+?)\s*$/.exec(line)
      if (item !== null) claims.push((item[1] ?? '').replace(/^['"]|['"]$/g, ''))
    }
  }
  return claims
}

function readDocClaims(root: string): readonly DocClaim[] {
  const claims: DocClaim[] = []
  for (const folder of ['docs/addons', 'docs/architecture', 'docs/ui']) {
    const dir = path.join(root, folder)
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.md')) continue
      const text = fs.readFileSync(path.join(dir, name), 'utf8')
      claims.push({ file: `${folder}/${name}`, patterns: frontmatterClaims(text) })
    }
  }
  return claims
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}`)
}

/** Docs whose `covers:` / `applies-to:` name files of this package, most claims first. */
export function docsFor(claims: readonly DocClaim[], pkg: WorkspacePackage): readonly string[] {
  const probe = `${pkg.dir}/x`
  const scored = claims
    .map((claim) => ({
      file: claim.file,
      score: claim.patterns.filter(
        (pattern) => pattern.startsWith(`${pkg.dir}/`) || globToRegExp(pattern).test(probe),
      ).length,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
  return scored.slice(0, 4).map((entry) => entry.file)
}

function renderRequirements(pkg: WorkspacePackage, addons: readonly ManifestAddon[]): readonly string[] {
  const lines: string[] = []
  const camstack = asRecord(pkg.manifest['camstack'])
  if (addons.length > 0) {
    const placements = addons.map((addon) => {
      const where = addon.placement.length > 0 ? addon.placement : 'default placement'
      return addon.group.length > 0 ? `${where} (runner group \`${addon.group}\`)` : where
    })
    if (new Set(placements).size === 1) {
      lines.push(`- Placement: ${placements[0]}.`)
    } else {
      for (const [index, addon] of addons.entries()) {
        lines.push(`- ${addon.name}: ${placements[index]}.`)
      }
    }
  }
  const runtime = strings(camstack['runtimeDependencies'])
  if (runtime.length > 0) lines.push(`- Runtime dependencies installed with the addon: ${runtime.map((d) => `\`${d}\``).join(', ')}.`)
  const native = asRecord(camstack['nativeDependencies'])
  const nativeNames = Object.keys(native)
  if (nativeNames.length > 0) lines.push(`- Native dependencies: ${nativeNames.map((d) => `\`${d}\``).join(', ')}.`)
  for (const addon of addons) {
    if (addon.pythonRequirements.length > 0) {
      lines.push(`- Python: ${addon.name} installs \`${addon.pythonRequirements.replace(/^\.\//, '')}\` into its own environment.`)
    }
    if (addon.systemDependencies.length > 0) {
      lines.push(`- System packages for ${addon.name}: ${addon.systemDependencies.map((d) => `\`${d}\``).join(', ')}.`)
    }
  }
  const engines = str(asRecord(pkg.manifest['engines'])['node'])
  if (engines.length > 0) lines.push(`- Node.js ${engines}.`)
  if (addons.length > 0) lines.push('- A CamStack hub. An agent is used only where the placement above allows it.')
  return lines
}

/** The derived block, markers included. Pure for a given workspace. */
export function renderGenerated(root: string, pkg: WorkspacePackage): string {
  const addons = readAddons(pkg)
  const lines: string[] = [GENERATED_START, '']
  lines.push(
    pkg.isPrivate
      ? `Package \`${pkg.name}\` — private, never published to npm.`
      : `Package \`${pkg.name}\` on npm.`,
    '',
  )

  if (addons.length > 0) {
    lines.push('## What it provides', '')
    for (const addon of addons) {
      const caps = addon.capabilities.map((cap) => `\`${cap}\``).join(', ')
      const detail = [addon.description.length > 0 ? sentence(addon.description) : '', addon.category.length > 0 ? `Category: ${addon.category}.` : '']
        .filter(Boolean)
        .join(' ')
      lines.push(`- **${addon.name}** (\`${addon.id}\`)${detail.length > 0 ? `: ${detail}` : ''}`)
      if (caps.length > 0) lines.push(`  - Capabilities: ${caps}.`)
    }
    lines.push('')
  }

  const settings = renderSettings(settingsFromLabels(readLabels(root, pkg)))
  if (settings.length > 0) {
    lines.push('## Configuration', '', 'Edit these from System, Addons, this addon, Settings (a device\'s own settings are on its device page). A password field is stored in the keychain.', '', ...settings)
  }

  const requirements = renderRequirements(pkg, addons)
  if (requirements.length > 0) lines.push('## Requirements', '', ...requirements, '')

  const links = docsFor(readDocClaims(root), pkg)
  const own = fs.existsSync(path.join(root, pkg.dir, 'AGENTS.md')) ? [`${pkg.dir}/AGENTS.md`] : []
  const all = [...links, ...own]
  if (all.length > 0) {
    lines.push('## Documentation', '')
    for (const file of all) lines.push(`- [${file}](${REPO_BLOB}/${file})`)
    lines.push('')
  }
  lines.push('See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.', '', GENERATED_END)
  return lines.join('\n')
}

const STUB_MARKER = 'Settings this addon exposes are edited from'

/** Insert or refresh the derived block in a README's text (null = no file). */
export function applyGenerated(existing: string | null, pkg: WorkspacePackage, block: string): string {
  if (existing !== null) {
    const start = existing.indexOf('<!-- readme:generated:start')
    const end = existing.indexOf(GENERATED_END)
    if (start !== -1 && end > start) {
      return `${existing.slice(0, start)}${block}${existing.slice(end + GENERATED_END.length)}`
    }
    if (!existing.includes(STUB_MARKER) && existing.trim().length > 0) {
      return `${existing.trimEnd()}\n\n${block}\n`
    }
  }
  return `# ${friendlyName(pkg)}\n\n${seedProse(pkg)}\n\n${block}\n`
}
