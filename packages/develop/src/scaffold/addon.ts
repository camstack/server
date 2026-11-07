import * as fs from 'node:fs'
import * as path from 'node:path'
import { toClassName, toFileName } from '../naming.js'
import { CORE_EXAMPLES } from '../examples/catalogue.js'
import type { ScaffoldAddonOptions, ScaffoldAddonResult } from '../types.js'
import {
  DEVICE_ADDON_TS,
  DEVICE_ADOPTION_TS,
  DEVICE_DEVICES_TS,
  DEVICE_INSTANCES_TS,
} from './integration-device.js'
import { EXPORTER_ADDON_TS, EXPORTER_INSTANCES_TS } from './integration-exporter.js'
import { SERVICE_ADDON_TS, SERVICE_INSTANCES_TS } from './integration-service.js'
import { renderTemplate } from './templates.js'

const KIND_EXAMPLE: Record<NonNullable<ScaffoldAddonOptions['kind']>, string | null> = {
  empty: null,
  provider: 'provider-rtsp',
  notifier: 'notifiers',
  osd: 'osd-manager',
  'post-analysis': 'post-analysis',
  'model-studio': 'model-studio',
  'admin-ui': 'admin-ui',
  'device-integration': 'provider-enpal',
  'service-integration': 'integration-service',
  exporter: 'ha-export',
}

export const INTEGRATION_NOTES: readonly string[] = [
  'Public examples: `camstack/addon-examples` (`example-device-integration`, `example-service-integration`, `example-exporter`).',
  '',
  'Integration rules (D1007, D996, D1009):',
  '- The integration is a typed instance record served through `integration-instances`; a secret is a `password` field (`.meta({ secret: true })` on the kind).',
  '- Addon-wide settings are scoped (D986): declare `scopedSettingsCapabilities()` plus `clusterSettingsSchema(cap)` / `nodeSettingsSchema(cap)` / `deviceDefaultsSchema(cap)`, and read or write them through `this.clusterSettings(cap, schema)` / `this.nodeSettings(cap, schema)` / `this.deviceDefaults(cap, schema)`. Callers go through `addonSettings.getScopedSettings` / `updateScopedSettings` / `readScopedValues`. No `integration_settings`, no `integrations.getSettings` / `setSettings` (retired).',
  '- Data changes go through a D987 migration with read-back, never a dual read path.',
  '- The Gateway is a SIBLING of the devices it brings, never their parent.',
  '- An exporter provides `integration-instances` and is multi-instance: minted ids, exposure keyed by instance id.',
  '',
]

/** What an integration kind changes in the generated package: manifest fields, caps, source files. */
interface IntegrationKindPlan {
  /** Manifest fields placed after the addon id. */
  readonly manifestFields: readonly string[]
  readonly capabilities: readonly string[]
  readonly category: string
  readonly files: readonly {
    readonly relative: string
    readonly template: string
  }[]
}

function integrationPlan(
  kind: NonNullable<ScaffoldAddonOptions['kind']>,
  fileName: string,
): IntegrationKindPlan | null {
  switch (kind) {
    case 'device-integration':
      return {
        manifestFields: [
          '"integrationRole": "devices"',
          '"instanceMode": "multiple"',
          '"mode": "account"',
        ],
        capabilities: [
          'device-provider',
          'integration-instances',
          'device-adoption',
          'device-removal-hook',
        ],
        category: 'providers',
        files: [
          { relative: `src/${fileName}.addon.ts`, template: DEVICE_ADDON_TS },
          {
            relative: `src/${fileName}-instances.ts`,
            template: DEVICE_INSTANCES_TS,
          },
          {
            relative: `src/${fileName}-devices.ts`,
            template: DEVICE_DEVICES_TS,
          },
          {
            relative: `src/${fileName}-adoption.ts`,
            template: DEVICE_ADOPTION_TS,
          },
        ],
      }
    case 'service-integration':
      return {
        manifestFields: ['"integrationRole": "services"', '"instanceMode": "multiple"'],
        capabilities: ['integration-instances'],
        category: 'messaging',
        files: [
          { relative: `src/${fileName}.addon.ts`, template: SERVICE_ADDON_TS },
          {
            relative: `src/${fileName}-instances.ts`,
            template: SERVICE_INSTANCES_TS,
          },
        ],
      }
    case 'exporter':
      return {
        manifestFields: ['"integrationRole": "services"', '"instanceMode": "multiple"'],
        capabilities: ['device-export', 'integration-instances'],
        category: 'messaging',
        files: [
          { relative: `src/${fileName}.addon.ts`, template: EXPORTER_ADDON_TS },
          {
            relative: `src/${fileName}-instances.ts`,
            template: EXPORTER_INSTANCES_TS,
          },
        ],
      }
    default:
      return null
  }
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

  const plan = integrationPlan(kind, fileName)
  vars['extraFields'] = (plan?.manifestFields ?? []).map((f) => `\n        ${f},`).join('')
  vars['categoryField'] = plan ? `\n        "category": "${plan.category}",` : ''
  vars['capabilities'] = JSON.stringify(
    (plan?.capabilities ?? []).map((name) => ({ name })),
    null,
    2,
  )
    .split('\n')
    .join('\n        ')

  const files: { relative: string; content: string }[] = [
    { relative: 'package.json', content: renderTemplate(PACKAGE_JSON, vars) },
    { relative: 'README.md', content: renderTemplate(README_MD, vars) },
    { relative: 'CHANGELOG.md', content: CHANGELOG_MD },
    { relative: 'tsconfig.json', content: renderTemplate(TSCONFIG, vars) },
    { relative: 'vite.config.ts', content: renderTemplate(VITE_CONFIG, vars) },
    { relative: 'src/index.ts', content: renderTemplate(INDEX_TS, vars) },
    ...(plan
      ? plan.files.map((f) => ({
          relative: f.relative,
          content: renderTemplate(f.template, vars),
        }))
      : [
          {
            relative: `src/${fileName}.addon.ts`,
            content: renderTemplate(ADDON_TS, vars),
          },
        ]),
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
        ...(plan ? INTEGRATION_NOTES : []),
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
        "id": "<%= fileName %>",<%= extraFields %><%= categoryField %>
        "name": "<%= displayName %>",
        "description": "<%= description %>",
        "entry": "./dist/<%= fileName %>.addon.js",
        "execution": {
          "placement": "hub-only"
        },
        "capabilities": <%= capabilities %>
      }
    ]
  },
  "files": [
    "dist",
    "README.md",
    "CHANGELOG.md"
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

const README_MD = `# <%= displayName %>

<%= description %>

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->
<!-- readme:generated:end -->
`

const CHANGELOG_MD = `# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release.
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

// An addon has no settings page of its own (D1007). What an operator
// configures is an integration INSTANCE (scaffold kind device-integration,
// service-integration or exporter); a per-device setting lives in
// ctx.settings.*DeviceStore. A setting that belongs to a capability this
// addon provides is SCOPED (D986): list the capability in
// scopedSettingsCapabilities(), return its form from clusterSettingsSchema(cap)
// or nodeSettingsSchema(cap), and read/write it through this.clusterSettings(cap,
// schema) / this.nodeSettings(cap, schema). No on/off switch: the capability
// toggle is an addon's ONE enable (D777).
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
