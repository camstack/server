/**
 * The published `@camstack/server` is the root of the framework closure. A
 * package patched by `closure-postinstall` must be declared there at EXACTLY
 * the patch's version: an addon-level pin nests under that addon, and a peer
 * range elsewhere in the closure can hoist another version to
 * `node_modules/<pkg>` — where the applier looks.
 */
export function closureRootPinProblem(
  rootDependencies: Readonly<Record<string, unknown>>,
  name: string,
  pinned: string,
): string | null {
  const range = rootDependencies[name]
  if (range === pinned) return null
  return (
    `@camstack/server (server/backend) must declare ${name} at exactly ${pinned} in ` +
    `"dependencies" (found ${range === undefined ? 'nothing' : JSON.stringify(range)}), ` +
    'or npm can hoist a version the patch does not apply to'
  )
}
