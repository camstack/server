/**
 * How one generated system hook is written. Kept apart from the generator
 * (which runs on import) so a spec can bundle the exact emitted text.
 *
 * A bare `export const X = trpc.a.b.useQuery` is a property read, which a
 * bundler must keep (a getter may have a side effect). Every addon page that
 * bundles ui-library's source then carries ALL ~hundreds of aliases, so one
 * new hook changed the built output of every page addon and the publish
 * output check republished them all (planning #332). Reading through a
 * PURE-annotated call lets an unused alias drop out; a used one is kept.
 */

/** The statement that precedes the hooks in the generated file. */
export const HOOK_ALIAS_HELPER = `/** Reads a hook off the trpc proxy; the PURE call at each use lets an unused alias tree-shake. */
const alias = <T>(read: () => T): T => read()`

/** One hook: a typed alias over `target` (`trpc.<cap>.<method>.useQuery`). */
export function emitHookEntry(name: string, target: string): string {
  return `/** Generated alias around \`${target}\`. */
export const ${name}: typeof ${target} = /*#__PURE__*/ alias(() => ${target})`
}
