import * as fs from 'node:fs'
import * as path from 'node:path'
import { toClassName, toFileName } from '../naming.js'
import { CORE_EXAMPLES } from '../examples/catalogue.js'
import type { ScaffoldAddonOptions, ScaffoldAddonResult } from '../types.js'
import { renderTemplate } from './templates.js'

const KIND_EXAMPLE: Record<NonNullable<ScaffoldAddonOptions['kind']>, string | null> = {
  empty: null,
  provider: 'provider-rtsp',
  notifier: 'notifiers',
  osd: 'osd-manager',
  'post-analysis': 'post-analysis',
  'model-studio': 'model-studio',
  'admin-ui': 'admin-ui',
}

/**
 * Scaffold a new addon package under `packages/addon-<name>/`.
 * Aligned with `@camstack/nx-plugin:addon` templates, plus a vite.config.ts
 * entries map (the silent miss the Nx generator historically omitted).
 */
export function scaffoldAddon(options: ScaffoldAddonOptions): ScaffoldAddonResult {
  const fileName = toFileName(options.name)
  const className = toClassName(fileName)
  const directory = options.directory ?? 'packages'
  const projectRoot = path.join(options.workspaceRoot, directory, `addon-${fileName}`)
  const displayName = options.displayName ?? className
  const description = options.description ?? `${displayName} — CamStack addon.`
  const kind = options.kind ?? 'empty'

  if (fs.existsSync(projectRoot) && !options.dryRun) {
    throw new Error(`Target already exists: ${projectRoot}`)
  }

  const vars: Record<string, string> = {
    fileName,
    className,
    displayName,
    description,
    projectRoot: path.relative(options.workspaceRoot, projectRoot).replace(/\\/g, '/'),
  }

  const files: { relative: string; content: string }[] = [
    { relative: 'package.json', content: renderTemplate(PACKAGE_JSON, vars) },
    { relative: 'tsconfig.json', content: renderTemplate(TSCONFIG, vars) },
    { relative: 'vite.config.ts', content: renderTemplate(VITE_CONFIG, vars) },
    { relative: 'src/index.ts', content: renderTemplate(INDEX_TS, vars) },
    {
      relative: `src/${fileName}.addon.ts`,
      content: renderTemplate(ADDON_TS, vars),
    },
  ]

  const exampleId = KIND_EXAMPLE[kind]
  const example = exampleId ? CORE_EXAMPLES.find((e) => e.id === exampleId) : undefined
  if (example) {
    files.push({
      relative: 'DEVELOP.md',
      content: [
        `# ${displayName}`,
        '',
        `Scaffolded as kind \`${kind}\`. Study this core example before wiring:`,
        '',
        `- \`${example.packageDir}\` — ${example.demonstrates}`,
        '',
        'Rules:',
        '- One addon = one process (shared `execution.group` only when allowed).',
        '- Never import another addon; use `ctx.api`.',
        '- Declare capabilities by name in `package.json` → `camstack.addons[].capabilities`.',
        '- After any `*.cap.ts` change: `npm run codegen`.',
        '- Deploy before expecting logs: `camstack deploy packages/addon-' + fileName + '`.',
        '',
      ].join('\n'),
    })
  }

  const written: string[] = []
  if (!options.dryRun) {
    for (const file of files) {
      const abs = path.join(projectRoot, file.relative)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, file.content, 'utf8')
      written.push(path.relative(options.workspaceRoot, abs))
    }
  } else {
    for (const file of files) {
      written.push(path.join(path.relative(options.workspaceRoot, projectRoot), file.relative))
    }
  }

  return {
    packageDir: projectRoot,
    relativeDir: path.relative(options.workspaceRoot, projectRoot),
    filesWritten: written,
    contents: files.map((file) => ({
      path: path.join(path.relative(options.workspaceRoot, projectRoot), file.relative),
      content: file.content,
    })),
    nextSteps: [
      `cd ${path.relative(options.workspaceRoot, projectRoot)}`,
      'Implement providers in onInitialize and declare caps in package.json',
      'npm run build -w @camstack/addon-' + fileName,
      'npx tsx scripts/check-addon-entries.ts',
      'camstack deploy packages/addon-' + fileName,
      ...(example
        ? [`Study example: ${example.packageDir}`]
        : [`camstack develop find-example <topic>`]),
    ],
  }
}

const PACKAGE_JSON = `{
  "name": "@camstack/addon-<%= fileName %>",
  "version": "0.1.0",
  "description": "<%= description %>",
  "keywords": [
    "camstack",
    "addon",
    "camstack-addon"
  ],
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "camstack": {
    "displayName": "<%= displayName %>",
    "addons": [
      {
        "id": "<%= fileName %>",
        "name": "<%= displayName %>",
        "description": "<%= description %>",
        "entry": "./dist/<%= fileName %>.addon.js",
        "execution": {
          "placement": "hub-only"
        },
        "capabilities": []
      }
    ]
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "peerDependencies": {
    "@camstack/types": "*"
  },
  "dependencies": {
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@camstack/types": "*",
    "typescript": "~6.0.3",
    "vite": "^8.0.11",
    "vitest": "^3.0.0"
  }
}
`

const TSCONFIG = `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": false,
    "noEmit": true
  },
  "include": [
    "src/**/*"
  ],
  "exclude": [
    "dist",
    "node_modules"
  ]
}
`

const VITE_CONFIG = `import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    '<%= fileName %>.addon': 'src/<%= fileName %>.addon.ts',
  },
  externals: 'self-contained',
})
`

const INDEX_TS = `export { <%= className %>Addon, default } from './<%= fileName %>.addon.js'
`

const ADDON_TS = `/**
 * <%= displayName %> — generated addon skeleton.
 *
 * Replace this scaffold with your real implementation. The default
 * \`onInitialize\` registers no capabilities, so the addon loads cleanly
 * but does nothing until you wire it up.
 *
 * Common next steps:
 *   1. Pick capabilities (\`camstack develop list-caps\` / \`find-example\`).
 *   2. Implement a provider conforming to the cap's \`InferProvider\`.
 *   3. Return them from \`onInitialize\` and declare names in
 *      \`package.json\` → \`camstack.addons[0].capabilities\`.
 *   4. \`camstack deploy packages/addon-<%= fileName %>\`.
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
