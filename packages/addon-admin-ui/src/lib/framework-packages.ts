/**
 * The packages that ship WITH the platform (the builtins live in
 * `@camstack/system`). An addon whose `manifest.packageName` is one of these
 * is a system addon; every other package is something the operator installed.
 * One list, read by the Addons page and by the Integrations page.
 */
export const FRAMEWORK_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  '@camstack/system',
  '@camstack/types',
  '@camstack/sdk',
  '@camstack/shm-ring',
  '@camstack/ui-library',
])

export function isFrameworkPackage(packageName: string | undefined): boolean {
  return packageName !== undefined && FRAMEWORK_PACKAGE_NAMES.has(packageName)
}
