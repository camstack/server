#!/usr/bin/env tsx
/**
 * Codegen: system-hooks — one named React-Query hook per `scope: 'system'`
 * capability method.
 *
 * The generated hooks are thin wrappers over
 * `trpc.<cap>.<method>.useQuery` / `useMutation` / `useSubscription` —
 * including push-subscription methods (`kind: 'subscription'`), which
 * land as typeof aliases over `useSubscription` so consumers can write
 * `useToastOnToast(undefined, { onData: cb })` instead of pulling the
 * full proxy chain. The previous decision to route push streams through
 * the eventBus-backed `useLiveEvent` only covers events that emit on
 * `EventBusService` — tRPC subscriptions backed by `iterableSubscription`
 * (currently `toast.onToast` and `addons.onAddonLogs`) need a per-cap
 * hook with the right output narrowing, so the codegen now emits one
 * uniform with queries/mutations.
 *
 * Naming rules — kept simple so the generator stays predictable:
 *   - `<cap>.list*` / `<cap>.get*` → `use<Cap><Method>` (e.g. `useAddonsListPages`).
 *   - `<cap>.<verb>X` → `use<Cap><Verb>X` (e.g. `useUserManagementCreateUser`).
 *   - `<cap>.on*` → `use<Cap>On*` (e.g. `useToastOnToast`).
 *
 * The user can rename specific hooks downstream if the generated name
 * is awkward for a given pair — the goal is mechanical coverage, not
 * editorial polish.
 *
 * Output: `packages/ui-library/src/generated/system-hooks.ts`.
 *
 * Run manually: npx tsx scripts/generate-system-hooks.ts
 */

import * as fs from 'node:fs'
import { writeIfChanged } from './codegen-write.ts'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllCaps, type CapInfo } from './lib/parse-cap.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')
const OUTPUT = path.join(ROOT, 'packages/ui-library/src/generated/system-hooks.ts')
const TRPC_ROUTER = path.join(ROOT, 'server/backend/src/api/trpc/trpc.router.ts')
const GENERATED_CAP_MOUNTS = path.join(ROOT, 'server/backend/src/api/trpc/generated-cap-mounts.ts')

interface SystemMethod {
  readonly name: string
  readonly kind: 'query' | 'mutation' | 'subscription'
}

interface SystemCap extends CapInfo {
  readonly systemMethods: readonly SystemMethod[]
}

/**
 * Caps whose codegen'd router is mounted on the AppRouter under a
 * hand-written wrapper with different method names. The skip-list keeps
 * the generator from emitting hooks that fail TS narrowing against the
 * actual `AppRouter` shape.
 *
 * Caps NOT mounted at all (no top-level key in `trpc.router.ts`) are
 * detected dynamically via `findMountedRouterKeys()` so the list stays
 * fresh when caps move on/off the router.
 *
 * Empty as of the addon-pages split (2026-05-06): the previous
 * `addonPages` entry was needed because the public listing wrapped a
 * collection cap with a different output shape. After the split into
 * `addon-pages-source` (collection, raw) + `addon-pages` (singleton,
 * enriched) the codegen emits the right hook signature directly.
 */
const SKIP_DRIFTED: ReadonlySet<string> = new Set([])

/**
 * Parse the backend's `trpc.router.ts` and return the set of top-level
 * router keys (`integrations`, `deviceManager`, `pipelineExecutor`, …).
 * Lives at codegen-time only — we never import the backend tree at
 * runtime.
 */
function findMountedRouterKeys(): ReadonlySet<string> {
  // Aggregate keys from both files: `trpc.router.ts` declares hand-
  // written + override caps, while `generated-cap-mounts.ts` declares
  // every auto-mounted cap. The composition uses `...mountAllCaps()`
  // to spread the latter, so we need both sources to know the full
  // top-level surface available on the AppRouter.
  const trpcRouterKeys = parseMountedKeysFromFile(TRPC_ROUTER)
  const autoMountKeys = parseMountedKeysFromFile(GENERATED_CAP_MOUNTS)
  return new Set<string>([...trpcRouterKeys, ...autoMountKeys])
}

/**
 * Lift mount keys out of a router-shaped file. Looks for object-literal
 * entries indented at exactly 4 spaces with the `<key>: <expr>` shape
 * (i.e. NOT a type annotation ending in `;`). Skips block comments to
 * avoid false-positives on indented `*` continuation lines.
 */
function parseMountedKeysFromFile(file: string): ReadonlySet<string> {
  const src = fs.readFileSync(file, 'utf8')
  // Locate every top-level mount key — they're all written at the
  // 4-space indent that the project uses for the `return { … }` body
  // of `buildCapabilityRouters`. The block is interleaved with nested
  // function calls and JSDoc, so a brace-counting scan would have to
  // skip strings/comments. Instead we lean on the invariant indent
  // (every entry sits at exactly 4 leading spaces, no more / no less)
  // and pre-strip block comments — `/** */` blocks may indent their
  // continuation lines to 4 spaces.
  const lines = src.split('\n')
  const keys = new Set<string>()
  let insideBlockComment = false
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (insideBlockComment) {
      if (/\*\//.test(line)) insideBlockComment = false
      continue
    }
    if (/^\s*\/\*\*/.test(line)) {
      // Single-line `/** … */` blocks open + close on one line.
      if (!/\*\//.test(line)) insideBlockComment = true
      continue
    }
    const m = line.match(/^ {4}([a-zA-Z_$][\w$]*):\s*[^=]/)
    // Avoid matching object-literal entries inside a function call
    // (those are deeper than 4 spaces). Also skip lines that look like
    // type annotations: `<key>: SomeType;` — a type annotation lands
    // at a different column inside `interface { … }`. Both are filtered
    // by requiring the line to NOT look like a type-only line (no `;`
    // at end).
    if (m && m[1] && !line.endsWith(';')) keys.add(m[1])
  }
  return keys
}

function pickSystemCaps(
  all: readonly CapInfo[],
  mounted: ReadonlySet<string>,
): readonly SystemCap[] {
  const out: SystemCap[] = []
  for (const c of all) {
    if (SKIP_DRIFTED.has(c.propertyName)) continue
    // `internal: true` caps are server-internal — never mounted on the
    // public AppRouter, so emitting React-Query hooks that resolve
    // through `trpc.<cap>.<method>` would fail TS narrowing against the
    // actual `AppRouter` shape. Mirror the same filter system-proxy
    // applies so the SDK and admin-ui surfaces stay aligned.
    if (c.internal) continue
    if (!mounted.has(c.propertyName)) continue
    // Both `scope: 'system'` and `scope: 'device'` caps end up mounted
    // at the top level of `trpc.router.ts` (one entry per cap router),
    // so consumers reach them through the same `trpc.<cap>.<method>`
    // surface. Emit hooks for every mounted cap.
    const systemMethods: SystemMethod[] = c.methods
      // NOTE: device-bound methods on system caps used to be filtered out
      // here under the assumption they'd flow through `DeviceProxy`, but
      // admin-ui pages routinely render a device list and need to call
      // these methods (e.g. `deviceManager.getDevice({ deviceId })`)
      // without the per-device proxy. Emit hooks for ALL methods on
      // every mounted system cap — including subscriptions — so the
      // canonical hook surface covers every accessible procedure.
      .map((m) => ({ name: m.name, kind: m.kind }))
    if (systemMethods.length === 0) continue
    out.push({ ...c, systemMethods })
  }
  return out.slice().sort((a, b) => a.propertyName.localeCompare(b.propertyName))
}

function pascal(s: string): string {
  return s.replace(/(^|[-_])([a-z])/g, (_, _sep, c: string) => c.toUpperCase())
}

function hookName(capProp: string, methodName: string): string {
  return `use${pascal(capProp)}${pascal(methodName)}`
}

async function main(): Promise<void> {
  const allCaps = parseAllCaps(CAPS_DIR)
  const mounted = findMountedRouterKeys()
  const systemCaps = pickSystemCaps(allCaps, mounted)

  console.log(`Generating system-hooks for ${systemCaps.length} system caps:`)
  for (const c of systemCaps) {
    console.log(
      `  ${c.propertyName}: ${c.systemMethods.map((m) => `${m.name}(${m.kind})`).join(', ')}`,
    )
  }
  const skippedScopeSystem = allCaps
    .filter(
      (c) => c.scope === 'system' && !systemCaps.some((s) => s.propertyName === c.propertyName),
    )
    .map((c) => c.propertyName)
  if (skippedScopeSystem.length > 0) {
    console.log(
      `\nSkipped (unmounted on AppRouter or in skip-list): ${skippedScopeSystem.join(', ')}`,
    )
  }

  const hookEntries: string[] = []

  for (const cap of systemCaps) {
    for (const method of cap.systemMethods) {
      const name = hookName(cap.propertyName, method.name)
      // The trpc proxy is a deep accessor: trpc.<cap>.<method>.useQuery({input}, opts).
      //
      // CRITICAL — emit a direct property alias (`export const X = trpc.<cap>.<method>.useQuery`)
      // rather than a wrapper function that passes `...args` through. The
      // tRPC React proxy's typed inference relies on consumer-side property
      // chain access — once the function is unpacked through `Parameters<>`
      // / `ReturnType<>` and re-applied via `(...args)`, the deep-proxy type
      // collapses to `{}`, which means `wrapped.data` shows up as `unknown`
      // and downstream `.map` calls fail with TS2339.
      // Aliasing the property reference preserves the full call-site
      // inference; consumers that want a typed return invoke the alias
      // exactly as they would have invoked `trpc.<cap>.<method>.useQuery`.
      const target =
        method.kind === 'query'
          ? `trpc.${cap.propertyName}.${method.name}.useQuery`
          : method.kind === 'mutation'
            ? `trpc.${cap.propertyName}.${method.name}.useMutation`
            : `trpc.${cap.propertyName}.${method.name}.useSubscription`
      // The explicit `typeof` annotation is required for the dts build:
      // tsup's rollup-dts can't otherwise re-export the proxy member
      // because its inferred type references the internal trpc-react
      // declaration files (`getQueryKey.d-XXX`). The annotation makes the
      // exported binding's type explicit and self-contained.
      hookEntries.push(
        `/** Generated alias around \`${target}\`. */
export const ${name}: typeof ${target} = ${target}`,
      )
    }
  }

  const output = `// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-system-hooks.ts
/* eslint-disable */

/**
 * Per-method React-Query hooks for every \`scope: 'system'\` capability.
 *
 * Each hook is a thin pass-through to \`trpc.<cap>.<method>.useQuery\` /
 * \`.useMutation\` / \`.useSubscription\` so the typed inference + RQ
 * cache/dedup keep working — the generator only contributes a consistent
 * name and stable export surface so admin-ui pages can write
 * \`useAddonsList()\` instead of \`trpc.addons.list.useQuery()\`.
 *
 * Push-subscription methods (\`kind: 'subscription'\`) emit a typeof
 * alias over \`useSubscription\`, so the call shape is
 * \`useToastOnToast(input, { onData: cb })\` — same as the underlying
 * tRPC hook. The eventBus-backed \`useLiveEvent\` (see
 * \`../hooks/use-live-event.ts\`) covers events that don't ride a tRPC
 * subscription; the two surfaces coexist by design.
 */
import { trpc } from '../trpc-react.js'

${hookEntries.join('\n\n')}
`

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  writeIfChanged(OUTPUT, output)
  console.log(`\nGenerated: ${OUTPUT}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
