/**
 * Judge the whole-capability links a cap declares under `customize.links`
 * (D1076). Pure: the loader hands every cap's runtime state in `capStates`.
 */
import { z } from 'zod'
import type { CustomizeCapLink } from '../../packages/types/src/capabilities/customize-spec.ts'
import type { CustomizeCapView, CustomizeViolation } from './customize-declaration.ts'
import { objectShape, resolveCustomizePath } from './customize-path.ts'

type Runtime = z.ZodType

function violation(
  view: CustomizeCapView,
  link: CustomizeCapLink,
  rule: CustomizeViolation['rule'],
  message: string,
): CustomizeViolation {
  return { capName: view.capName, targetId: link.id, rule, message }
}

/** The quantity a field's own `.meta({ quantity })` declares, through any wrapper. */
function quantityOf(schema: z.ZodType): string | undefined {
  let current: z.ZodType = schema
  for (let guard = 0; guard < 16; guard += 1) {
    const meta: unknown = z.globalRegistry.get(current)
    if (typeof meta === 'object' && meta !== null) {
      const quantity: unknown = Reflect.get(meta, 'quantity')
      if (typeof quantity === 'string') return quantity
    }
    if (
      current instanceof z.ZodNullable ||
      current instanceof z.ZodOptional ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodReadonly ||
      current instanceof z.ZodCatch
    ) {
      const inner: unknown = current.unwrap()
      if (!(inner instanceof z.ZodType)) return undefined
      current = inner
      continue
    }
    return undefined
  }
  return undefined
}

function fieldSchemaAt(root: Runtime, dotted: string): z.ZodType | undefined {
  let current: z.ZodType = root
  for (const segment of dotted.split('.')) {
    const next = objectShape(current)?.[segment]
    if (next === undefined) return undefined
    current = next
  }
  return current
}

function judgeSlot(
  view: CustomizeCapView,
  link: CustomizeCapLink,
  runtime: Runtime,
): readonly CustomizeViolation[] {
  if (link.slot === undefined) {
    return [violation(view, link, 'bad-link-slot', 'a reference link names the `slot` it fills')]
  }
  if (link.slot.includes('.')) {
    return [
      violation(view, link, 'bad-link-slot', `slot \`${link.slot}\` is not a top-level field`),
    ]
  }
  const resolved = resolveCustomizePath(runtime, link.slot)
  if (!resolved.ok) {
    return [violation(view, link, 'bad-link-slot', `slot \`${link.slot}\` is not in runtimeState`)]
  }
  if (resolved.hit.kind !== 'object' || !resolved.hit.nullable) {
    return [
      violation(
        view,
        link,
        'bad-link-slot',
        `slot \`${link.slot}\` must be a nullable object (an absent part reads null, D393)`,
      ),
    ]
  }
  return []
}

function judgeMap(
  view: CustomizeCapView,
  link: CustomizeCapLink,
  runtime: Runtime,
  sourceState: Runtime | undefined,
): readonly CustomizeViolation[] {
  return Object.entries(link.map ?? {}).flatMap(([host, source]) => {
    const hostField = fieldSchemaAt(runtime, host)
    if (hostField === undefined) {
      return [violation(view, link, 'bad-link-map', `map key \`${host}\` is not in runtimeState`)]
    }
    const sourceField = sourceState === undefined ? undefined : fieldSchemaAt(sourceState, source)
    if (sourceField === undefined) {
      return [
        violation(
          view,
          link,
          'bad-link-map',
          `map value \`${source}\` is not in \`${link.sourceCap}\` runtimeState`,
        ),
      ]
    }
    const [hostQuantity, sourceQuantity] = [quantityOf(hostField), quantityOf(sourceField)]
    return hostQuantity === sourceQuantity
      ? []
      : [
          violation(
            view,
            link,
            'bad-link-map',
            `map \`${host}\` -> \`${source}\` joins quantity ${hostQuantity ?? '(none)'} to ${sourceQuantity ?? '(none)'}`,
          ),
        ]
  })
}

function judgeLink(
  view: CustomizeCapView,
  link: CustomizeCapLink,
  runtime: Runtime | undefined,
): readonly CustomizeViolation[] {
  if (link.apply !== 'add') {
    return [
      violation(view, link, 'bad-link-apply', `link \`${link.id}\` apply is not 'add' (D944)`),
    ]
  }
  if (runtime === undefined) {
    return [violation(view, link, 'no-runtime-state', 'a link needs the host runtimeState')]
  }
  const capStates = view.capStates
  if (capStates === undefined || !capStates.has(link.sourceCap)) {
    return [
      violation(view, link, 'unknown-link-source-cap', `sourceCap \`${link.sourceCap}\` is no cap`),
    ]
  }
  const sourceState = capStates.get(link.sourceCap)
  if (link.mode === 'reference') {
    return [
      ...(link.map === undefined
        ? []
        : [violation(view, link, 'bad-link-map', 'a reference link carries no map')]),
      ...judgeSlot(view, link, runtime),
    ]
  }
  if (link.slot !== undefined) {
    return [violation(view, link, 'bad-link-slot', 'a project link has no slot')]
  }
  if (link.map === undefined) {
    return link.sourceCap === view.capName
      ? []
      : [
          violation(
            view,
            link,
            'bad-link-project',
            `a project link to \`${link.sourceCap}\` needs a map (identity needs the same cap)`,
          ),
        ]
  }
  return judgeMap(view, link, runtime, sourceState)
}

export function judgeCustomizeLinks(view: CustomizeCapView): readonly CustomizeViolation[] {
  const links = view.customize?.links ?? []
  const seen = new Set<string>()
  return links.flatMap((link) => {
    const dup = seen.has(link.id)
    seen.add(link.id)
    return [
      ...(dup
        ? [violation(view, link, 'duplicate-link', `link \`${link.id}\` is declared twice`)]
        : []),
      ...judgeLink(view, link, view.runtimeState),
    ]
  })
}
