import * as fs from 'node:fs'
import * as path from 'node:path'
import { toCapExportName, toClassName, toFileName } from '@camstack/develop'
import { unifiedDiff } from '../diff.js'
import { confine } from '../fs-confine.js'
import { ARCHETYPES, type CapArchetype } from './archetypes.js'

export interface ScaffoldCapabilityResult {
  readonly dryRun: boolean
  readonly archetype: CapArchetype
  readonly files: readonly {
    path: string
    action: 'create' | 'patch'
    contentPreview: string
    diff: string
  }[]
  readonly nextSteps: readonly string[]
}

export function scaffoldCapability(options: {
  workspaceRoot: string
  name: string
  archetype: CapArchetype
  apply?: boolean
}): ScaffoldCapabilityResult {
  const plan = ARCHETYPES[options.archetype]
  const fileName = toFileName(options.name)
  const exportName = toCapExportName(fileName)
  const typeName = `I${toClassName(fileName)}Provider`
  const capsDir = path.join(options.workspaceRoot, 'packages', 'types', 'src', 'capabilities')
  const capPath = path.join(capsDir, `${fileName}.cap.ts`)
  const indexPath = path.join(capsDir, 'index.ts')
  const specPath = path.join(
    options.workspaceRoot,
    'server',
    'backend',
    'src',
    '__tests__',
    'cap-routers',
    `${fileName}.spec.ts`,
  )

  // Writes are confined to the workspace (plan §3.10), dry run or not.
  for (const target of [capPath, indexPath, specPath]) confine(options.workspaceRoot, target)

  const content = renderCapStub(fileName, exportName, typeName, plan)
  const specContent = renderSpecStub(fileName, exportName)
  const indexBefore = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : null
  const indexAfter =
    indexBefore === null ? null : renderPatchedIndex(indexBefore, fileName, exportName, typeName)
  const files: ScaffoldCapabilityResult['files'][number][] = [
    {
      path: path.relative(options.workspaceRoot, capPath),
      action: 'create',
      contentPreview: content.slice(0, 500),
      diff: unifiedDiff(path.relative(options.workspaceRoot, capPath), null, content),
    },
    {
      path: path.relative(options.workspaceRoot, indexPath),
      action: 'patch',
      contentPreview: `// re-export ${exportName} + add to AnyCapability union`,
      diff:
        indexBefore === null || indexAfter === null
          ? ''
          : unifiedDiff(path.relative(options.workspaceRoot, indexPath), indexBefore, indexAfter),
    },
    {
      path: path.relative(options.workspaceRoot, specPath),
      action: 'create',
      contentPreview: specContent.slice(0, 400),
      diff: unifiedDiff(path.relative(options.workspaceRoot, specPath), null, specContent),
    },
  ]

  if (options.apply) {
    if (!fs.existsSync(capsDir)) throw new Error(`Missing ${capsDir}`)
    if (fs.existsSync(capPath)) throw new Error(`Cap already exists: ${capPath}`)
    fs.writeFileSync(capPath, content, 'utf8')
    if (indexAfter === null) throw new Error(`Missing capability index: ${indexPath}`)
    if (indexAfter !== indexBefore) fs.writeFileSync(indexPath, indexAfter, 'utf8')
    fs.mkdirSync(path.dirname(specPath), { recursive: true })
    if (!fs.existsSync(specPath)) {
      fs.writeFileSync(specPath, specContent, 'utf8')
    }
  }

  return {
    dryRun: options.apply !== true,
    archetype: options.archetype,
    files,
    nextSteps: [
      options.apply
        ? `Wrote ${path.relative(options.workspaceRoot, capPath)}`
        : 'Re-run with apply:true to write files (dry-run by default)',
      'Fill methods + auth on the stub',
      'Declare the cap by name in the providing addon manifest',
      plan.scope === 'device' || options.archetype === 'device-native'
        ? 'Implement via ctx.registerNativeCap on a BaseDevice'
        : 'Implement via context.registerProvider',
      'If the cap must exist on agents, add it to server/backend/src/agent/main.ts',
      'npm run codegen',
      'npx tsx scripts/check-method-tiers.ts --update (review widened tiers)',
      'Append ../planning/sessions/<YYYY-MM>.md (private diary, not published); npm run docs:check',
      'Ship: force-publish @camstack/system when the contract changes (see cap_ship_plan)',
    ],
  }
}

function renderCapStub(
  fileName: string,
  exportName: string,
  typeName: string,
  plan: (typeof ARCHETYPES)[CapArchetype],
): string {
  const extra: string[] = []
  if (plan.archetype === 'device-native') extra.push('  deviceNative: true,')
  if (plan.archetype === 'wrapper') extra.push('  defaultActive: true,')
  if (plan.archetype === 'internal') {
    extra.push('  internal: true,')
    extra.push("  mount: { kind: 'skip' },")
  }

  return `import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * ${fileName} — scaffolded as archetype \`${plan.archetype}\` by camstack-dev.
 *
 * Required fields for this archetype:
${plan.fields.map((f) => ` *   - ${f}`).join('\n')}
 *
 * Guards: ${plan.guards.map((g) => path.basename(g)).join(', ')}
 * Example: ${plan.exampleCap}
 */
export const ${exportName} = {
  name: '${fileName}',
  scope: '${plan.scope}',
  mode: '${plan.mode}',
${extra.length ? extra.join('\n') + '\n' : ''}  methods: {
    // ping: {
    //   input: z.object({}),
    //   output: z.object({ ok: z.boolean() }),
    //   auth: 'admin',
    // },
  },
  runtimeState: {
    lastFetchedAt: z.number(),
  },
} as const satisfies CapabilityDefinition

export type ${typeName} = InferProvider<typeof ${exportName}>
`
}

function renderSpecStub(fileName: string, exportName: string): string {
  return `import { describe, expect, it } from 'vitest'
import { ${exportName} } from '@camstack/types'

describe('${fileName} cap router (stub)', () => {
  it('is registered under the expected name', () => {
    expect(${exportName}.name).toBe('${fileName}')
  })
})
`
}

/** The capability index text after the new cap is exported and added to the union (pure). */
export function renderPatchedIndex(
  original: string,
  fileName: string,
  exportName: string,
  typeName: string,
): string {
  let text = original
  if (text.includes(exportName)) return text

  const exportBlock = `export { ${exportName}, type ${typeName} } from './${fileName}.cap.js'\n`
  // Insert before AnyCapability if present, else append.
  if (text.includes('export type AnyCapability')) {
    text = text.replace(/export type AnyCapability/, `${exportBlock}\nexport type AnyCapability`)
    // Add to union — find `| typeof someCapability` pattern end
    if (!text.includes(`typeof ${exportName}`)) {
      text = text.replace(
        /(export type AnyCapability\s*=\s*[\s\S]*?)(\n\s*export type CapabilityName)/,
        `$1\n  | typeof ${exportName}$2`,
      )
      // Fallback: append before last export type CapabilityName differently
      if (!text.includes(`typeof ${exportName}`)) {
        text = text.replace(
          /(export type AnyCapability\s*=)([\s\S]*?)(\nexport )/m,
          `$1$2\n  | typeof ${exportName}$3`,
        )
      }
    }
  } else {
    text += `\n${exportBlock}`
  }
  return text
}
