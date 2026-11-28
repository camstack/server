/**
 * The packages that ship WITH the platform (the builtins live in
 * `@dominevo/server/system`). An addon whose `manifest.packageName` is one of these
 * is a system addon; every other package is something the operator installed.
 * One list, read by the Addons page and by the Integrations page.
 */
export const FRAMEWORK_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  '@dominevo/server',
  '@dominevo/types',
  '@dominevo/sdk',
  '@dominevo/shm-ring',
  '@dominevo/ui-library',
])

export function isFrameworkPackage(packageName: string | undefined): boolean {
  return packageName !== undefined && FRAMEWORK_PACKAGE_NAMES.has(packageName)
}

/**
 * Packages a node runs itself and the hub never installs: the framework packages (they travel
 * inside the server closure) plus the agent's own UI. Never stale, never listed as node-only.
 * Derived from the one list above — a page does not spell package names.
 */
const AGENT_UI_PACKAGE = '@dominevo/addon-agent-ui'

export function isSelfManagedPackage(packageName: string): boolean {
  return isFrameworkPackage(packageName) || packageName === AGENT_UI_PACKAGE
}
