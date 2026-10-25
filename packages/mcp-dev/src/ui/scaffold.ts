/**
 * `scaffold_ui_component` — a library component in the right tier, exported
 * from the barrel, with a spec. Dry run by default and the dry run IS a diff;
 * `apply:true` writes, and every write is confined to the workspace.
 *
 * It scaffolds structure only: no colour, no spacing in `style`, tokens through
 * `cn()`. After applying, the printed next steps (catalogue regeneration,
 * `ui:check`, `ui:shots`) are the part that makes it done.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { unifiedDiff } from '../diff.js'
import { confine, ConfinementError } from '../fs-confine.js'

export type UiTier = 'primitive' | 'composite'
export const UiTierSchema: z.ZodType<UiTier> = z.enum(['primitive', 'composite'])

export interface ScaffoldUiArgs {
  name: string
  tier: UiTier
  description?: string
  apply?: boolean
}

export const ScaffoldUiArgsSchema: z.ZodType<ScaffoldUiArgs> = z.object({
  name: z.string().regex(/^[A-Z][A-Za-z0-9]{1,40}$/, 'PascalCase, e.g. TrackTimeline'),
  tier: UiTierSchema,
  description: z.string().max(300).optional(),
  apply: z.boolean().optional(),
})

export interface PlannedFile {
  readonly path: string
  readonly action: 'create' | 'patch'
  readonly diff: string
}

export type ScaffoldUiResult =
  | { readonly status: 'refused'; readonly reason: string }
  | {
      readonly status: 'dry-run' | 'applied'
      readonly files: readonly PlannedFile[]
      readonly similarExisting: readonly string[]
      readonly nextSteps: readonly string[]
    }

export function kebabOf(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

function renderComponent(name: string, description: string): string {
  return `/**
 * ${name} — ${description}
 */
import type { JSX, ReactNode } from 'react'
import { cn } from '../lib/cn'

export interface ${name}Props {
  readonly children?: ReactNode
  readonly className?: string
}

export function ${name}({ children, className }: ${name}Props): JSX.Element {
  return <div className={cn('flex flex-col gap-2', className)}>{children}</div>
}
`
}

function renderSpec(name: string, kebab: string): string {
  return `// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ${name} } from '../${kebab}'

describe('${name}', () => {
  it('renders its children', () => {
    render(<${name}>content</${name}>)
    expect(screen.getByText('content')).toBeTruthy()
  })

  it('merges a caller className', () => {
    const { container } = render(<${name} className="extra">x</${name}>)
    expect(container.firstElementChild?.className).toContain('extra')
  })
})
`
}

/** The barrel text after the export is added; composites list names, primitives use `export *`. */
export function patchBarrel(before: string, tier: UiTier, name: string, kebab: string): string {
  const lines =
    tier === 'primitive'
      ? [`export * from './${kebab}'`]
      : [`export type { ${name}Props } from './${kebab}'`, `export { ${name} } from './${kebab}'`]
  const body = before.endsWith('\n') ? before : `${before}\n`
  return `${body}${lines.join('\n')}\n`
}

function similarInCatalogue(root: string, name: string): string[] {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(root, 'docs', 'reference', 'ui-components.json'), 'utf8'),
    )
    const entries: unknown =
      parsed !== null && typeof parsed === 'object' ? Reflect.get(parsed, 'entries') : undefined
    if (!Array.isArray(entries)) return []
    const words = name.split(/(?=[A-Z])/).map((w) => w.toLowerCase())
    const hits: string[] = []
    for (const entry of entries) {
      const entryName: unknown =
        entry !== null && typeof entry === 'object' ? Reflect.get(entry, 'name') : null
      if (typeof entryName !== 'string') continue
      const lower = entryName.toLowerCase()
      if (words.some((w) => w.length > 3 && lower.includes(w))) hits.push(entryName)
    }
    return hits.slice(0, 15)
  } catch {
    return []
  }
}

export function scaffoldUiComponent(root: string, args: ScaffoldUiArgs): ScaffoldUiResult {
  const kebab = kebabOf(args.name)
  const dir = path.join(
    'packages',
    'ui-library',
    'src',
    `${args.tier === 'primitive' ? 'primitives' : 'composites'}`,
  )
  const componentRel = path.join(dir, `${kebab}.tsx`)
  const specRel = path.join(dir, '__tests__', `${kebab}.test.tsx`)
  const barrelRel = path.join(dir, 'index.ts')
  try {
    const componentAbs = confine(root, componentRel)
    const specAbs = confine(root, specRel)
    const barrelAbs = confine(root, barrelRel)
    if (!fs.existsSync(barrelAbs)) {
      return {
        status: 'refused',
        reason: `missing barrel ${barrelRel} — is this the CamStack workspace?`,
      }
    }
    if (fs.existsSync(componentAbs) || fs.existsSync(specAbs)) {
      return { status: 'refused', reason: `${componentRel} or its spec already exists` }
    }
    const barrelBefore = fs.readFileSync(barrelAbs, 'utf8')
    if (barrelBefore.includes(`'./${kebab}'`)) {
      return { status: 'refused', reason: `${barrelRel} already exports ./${kebab}` }
    }
    const component = renderComponent(args.name, args.description ?? `${args.name} (describe it).`)
    const spec = renderSpec(args.name, kebab)
    const barrelAfter = patchBarrel(barrelBefore, args.tier, args.name, kebab)
    const files: PlannedFile[] = [
      { path: componentRel, action: 'create', diff: unifiedDiff(componentRel, null, component) },
      { path: specRel, action: 'create', diff: unifiedDiff(specRel, null, spec) },
      { path: barrelRel, action: 'patch', diff: unifiedDiff(barrelRel, barrelBefore, barrelAfter) },
    ]
    if (args.apply === true) {
      fs.mkdirSync(path.dirname(specAbs), { recursive: true })
      fs.writeFileSync(componentAbs, component, 'utf8')
      fs.writeFileSync(specAbs, spec, 'utf8')
      fs.writeFileSync(barrelAbs, barrelAfter, 'utf8')
    }
    return {
      status: args.apply === true ? 'applied' : 'dry-run',
      files,
      similarExisting: similarInCatalogue(root, args.name),
      nextSteps: [
        args.apply === true
          ? 'Fill the component; keep colour and spacing in tokens (cn classes), never style=.'
          : 'Re-run with apply:true to write these files. Check similarExisting first: search before building.',
        'npm run ui:catalogue',
        `npm run ui:check -- ${componentRel}   # 0 new findings`,
        `npx vitest run ${specRel}`,
        'npm run ui:shots before/after for any route that mounts it (dark + light, desktop + phone)',
      ],
    }
  } catch (err) {
    if (err instanceof ConfinementError) return { status: 'refused', reason: err.message }
    throw err
  }
}
