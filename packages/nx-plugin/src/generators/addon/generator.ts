import { formatFiles, generateFiles, joinPathFragments, names, type Tree } from '@nx/devkit'
import * as path from 'node:path'
import type { AddonGeneratorSchema } from './schema.js'

/**
 * Scaffold a new CamStack addon workspace package.
 *
 * Layout produced under `${directory}/addon-${name}/`:
 *   package.json    — name=@camstack/addon-<name>, manifest, build/deploy scripts
 *   project.json    — nx targets: build, deploy (via @camstack/nx-plugin)
 *   vite.config.ts  — entries map (silent miss without this — runtime only)
 *   tsconfig.json   — composite, extends base
 *   src/index.ts    — barrel
 *   src/<name>.addon.ts — BaseAddon skeleton ready to extend
 *
 * Prefer `camstack develop scaffold addon <name>` for the same layout from the
 * CLI / MCP (shared `@camstack/develop` implementation).
 *
 * Run with:
 *   nx g @camstack/nx-plugin:addon weather-station --displayName "Weather Station"
 */
export default async function addonGenerator(
  tree: Tree,
  options: AddonGeneratorSchema,
): Promise<void> {
  const naming = names(options.name)
  const fileName = naming.fileName
  const className = naming.className
  const directory = options.directory ?? 'packages'
  const projectRoot = joinPathFragments(directory, `addon-${fileName}`)
  const displayName = options.displayName ?? naming.className
  const description = options.description ?? `${displayName} — CamStack addon.`

  const substitutions = {
    fileName,
    className,
    projectRoot,
    displayName,
    description,
    // EJS-style template `<%= … %>` requires plain string values
    template: '',
  }

  // Generate the file tree from `files/`, stripping `.template` suffix
  // and substituting __addon__ in filenames to the addon's fileName.
  generateFiles(tree, path.join(__dirname, 'files'), projectRoot, substitutions)

  // Rename the addon-source template file. `generateFiles` doesn't do
  // identifier-aware filename rewrites on its own; we walk the produced
  // paths and rename `__addon__.addon.ts` → `<fileName>.addon.ts`.
  const placeholder = joinPathFragments(projectRoot, 'src', '__addon__.addon.ts')
  if (tree.exists(placeholder)) {
    const content = tree.read(placeholder, 'utf-8') ?? ''
    tree.write(joinPathFragments(projectRoot, 'src', `${fileName}.addon.ts`), content)
    tree.delete(placeholder)
  }

  // Drop the `.template` suffix that prevented Nx from interpreting
  // these as workspace files at lookup time. Same pattern as the
  // upstream @nx generators ship — keep template extension off the
  // produced output so tooling treats them as the real config.
  for (const file of tree.listChanges()) {
    if (file.path.endsWith('.template')) {
      const targetPath = file.path.replace(/\.template$/, '')
      const content = tree.read(file.path, 'utf-8') ?? ''
      tree.write(targetPath, content)
      tree.delete(file.path)
    }
  }

  await formatFiles(tree)
}
