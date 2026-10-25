import * as fs from 'node:fs'
import * as path from 'node:path'
import { findAddonPackage } from '../catalogue/addons.js'
import { toClassName, toFileName } from '../naming.js'
import { asRecord, readJsonFile } from '../workspace.js'
import type { ExtendAddonOptions, ExtendAddonResult } from '../types.js'
import { renderTemplate } from './templates.js'

/**
 * Extend an existing addon package with a new manifest entry + stub source
 * + vite entries key. Used when one npm package ships multiple addons
 * (auth, cloudflare, tailscale pattern).
 */
export function extendAddon(options: ExtendAddonOptions): ExtendAddonResult {
  const pkg = findAddonPackage(options.workspaceRoot, options.addon)
  if (!pkg) {
    throw new Error(`Addon package not found: ${options.addon}`)
  }

  const entryId = toFileName(options.entryId)
  const className = toClassName(entryId)
  const displayName = options.displayName ?? className
  const description = options.description ?? `${displayName} — CamStack addon entry.`

  if (pkg.addons.some((a) => a.id === entryId)) {
    throw new Error(`Manifest already has addon id: ${entryId}`)
  }

  const addonSourceRel = `src/${entryId}.addon.ts`
  const addonSourceAbs = path.join(pkg.packageDir, addonSourceRel)
  if (fs.existsSync(addonSourceAbs) && !options.dryRun) {
    throw new Error(`Source already exists: ${addonSourceAbs}`)
  }

  const vars: Record<string, string> = {
    fileName: entryId,
    className,
    displayName,
    description,
    projectRoot: pkg.relativeDir.replace(/\\/g, '/'),
  }

  const addonTs = renderTemplate(ADDON_TS, vars)
  const written: string[] = []

  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(addonSourceAbs), { recursive: true })
    fs.writeFileSync(addonSourceAbs, addonTs, 'utf8')
    written.push(path.relative(options.workspaceRoot, addonSourceAbs))

    patchPackageJson(pkg.packageDir, {
      id: entryId,
      name: displayName,
      description,
      entry: `./dist/${entryId}.addon.js`,
    })
    written.push(path.relative(options.workspaceRoot, path.join(pkg.packageDir, 'package.json')))

    patchViteConfig(pkg.packageDir, entryId, addonSourceRel)
    const vitePath = path.join(pkg.packageDir, 'vite.config.ts')
    if (fs.existsSync(vitePath)) {
      written.push(path.relative(options.workspaceRoot, vitePath))
    }

    patchIndexBarrel(pkg.packageDir, className, entryId)
    const indexPath = path.join(pkg.packageDir, 'src', 'index.ts')
    if (fs.existsSync(indexPath)) {
      written.push(path.relative(options.workspaceRoot, indexPath))
    }
  } else {
    written.push(path.relative(options.workspaceRoot, addonSourceAbs))
    written.push(path.join(pkg.relativeDir, 'package.json'))
    written.push(path.join(pkg.relativeDir, 'vite.config.ts'))
  }

  return {
    packageDir: pkg.packageDir,
    entryId,
    filesWritten: written,
    nextSteps: [
      `Implement ${addonSourceRel}`,
      'Confirm vite.config.ts entries map includes the new stem',
      'npm run build -w ' + pkg.packageName,
      'npx tsx scripts/check-addon-entries.ts',
      'camstack deploy ' + pkg.relativeDir,
    ],
  }
}

function patchPackageJson(
  pkgDir: string,
  entry: {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly entry: string
  },
): void {
  const pkgPath = path.join(pkgDir, 'package.json')
  const pkg = readJsonFile(pkgPath)
  if (!pkg) throw new Error(`Cannot read ${pkgPath}`)
  const camstack = asRecord(pkg['camstack'])
  if (!camstack) throw new Error(`${pkgPath}: missing camstack manifest`)
  const addons = Array.isArray(camstack['addons']) ? [...camstack['addons']] : []
  addons.push({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    entry: entry.entry,
    execution: { placement: 'hub-only' },
    capabilities: [],
  })
  camstack['addons'] = addons
  pkg['camstack'] = camstack
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
}

function patchViteConfig(pkgDir: string, stem: string, sourceRel: string): void {
  const vitePath = path.join(pkgDir, 'vite.config.ts')
  if (!fs.existsSync(vitePath)) {
    fs.writeFileSync(
      vitePath,
      `import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    '${stem}.addon': '${sourceRel}',
  },
  externals: 'self-contained',
})
`,
      'utf8',
    )
    return
  }

  let text = fs.readFileSync(vitePath, 'utf8')
  if (text.includes(`'${stem}.addon'`) || text.includes(`"${stem}.addon"`)) return

  const entriesMatch = /entries\s*[:=]\s*\{/.exec(text)
  if (!entriesMatch || entriesMatch.index === undefined) {
    throw new Error(
      `${vitePath}: could not find entries map — add '${stem}.addon': '${sourceRel}' manually`,
    )
  }
  const insertAt = entriesMatch.index + entriesMatch[0].length
  const line = `\n    '${stem}.addon': '${sourceRel}',`
  text = text.slice(0, insertAt) + line + text.slice(insertAt)
  fs.writeFileSync(vitePath, text, 'utf8')
}

function patchIndexBarrel(pkgDir: string, className: string, fileName: string): void {
  const indexPath = path.join(pkgDir, 'src', 'index.ts')
  const line = `export { ${className}Addon } from './${fileName}.addon.js'\n`
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, line, 'utf8')
    return
  }
  const existing = fs.readFileSync(indexPath, 'utf8')
  if (existing.includes(`${className}Addon`)) return
  fs.writeFileSync(
    indexPath,
    existing.endsWith('\n') ? existing + line : `${existing}\n${line}`,
    'utf8',
  )
}

const ADDON_TS = `/**
 * <%= displayName %> — extended addon entry skeleton.
 */
import { BaseAddon, type ProviderRegistration } from '@camstack/types'

// Operator-visible config fields go here, each with a default below and a
// field in a \`globalSettingsSchema()\` override. No on/off switch: the
// capability toggle is an addon's ONE enable (D777). An addon that needs a
// setting to do anything (a URL, a token) treats the empty value as inert.
type <%= className %>Config = Readonly<Record<string, never>>

const DEFAULTS: <%= className %>Config = {}

export class <%= className %>Addon extends BaseAddon<<%= className %>Config> {
  constructor() {
    super({ ...DEFAULTS })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.ctx.logger.info('<%= displayName %> addon initialized')
    return []
  }
}

export default <%= className %>Addon
`
