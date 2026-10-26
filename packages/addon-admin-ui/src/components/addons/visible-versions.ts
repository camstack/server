/**
 * Which published versions the picker shows.
 *
 * `latest` is always listed. Every other non-deprecated version is listed.
 * Deprecated versions that are not `latest` stay hidden until the operator
 * asks for older versions (a rollback). The flag is the npm packument string,
 * read on the hub — a missing field is not deprecated.
 */

export interface VersionListEntry {
  readonly version: string
  readonly distTags: readonly string[]
  readonly deprecated?: string | undefined
}

export function isDeprecatedVersion(entry: { readonly deprecated?: string | undefined }): boolean {
  return typeof entry.deprecated === 'string' && entry.deprecated.length > 0
}

export function versionsForPicker<T extends VersionListEntry>(
  versions: readonly T[],
  showOlder: boolean,
): readonly T[] {
  if (showOlder) return versions
  return versions.filter(
    (entry) => entry.distTags.includes('latest') || !isDeprecatedVersion(entry),
  )
}

export function hiddenOlderVersionCount(versions: readonly VersionListEntry[]): number {
  return versions.length - versionsForPicker(versions, false).length
}
