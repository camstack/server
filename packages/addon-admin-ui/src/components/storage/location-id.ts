/**
 * Helpers for generating canonical `StorageLocation.id` values.
 *
 * The persisted record's `id` follows `^[a-z][a-z0-9-]*:[a-z0-9-]+$`.
 * The Add-Location wizard auto-derives a candidate id from the user-
 * supplied display name so operators don't have to construct one by
 * hand. Operators can still override before save.
 *
 * Pure module so the slug logic is unit-testable without React.
 */

export function slugifyDisplayName(displayName: string): string {
  const trimmed = displayName.trim().toLowerCase()
  if (trimmed.length === 0) return ''
  // Replace any run of non-alphanumeric chars with a single hyphen,
  // strip leading/trailing hyphens. Empty after sanitization → empty
  // result so the caller can fall back to a default ('default').
  const slug = trimmed.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug
}

/**
 * Build a canonical `<type>:<slug>` id. When the slug ends up empty
 * (e.g. user typed only punctuation), we fall back to `default` so the
 * regex in `StorageLocationSchema.id` still validates.
 */
export function buildLocationId(type: string, displayName: string): string {
  const slug = slugifyDisplayName(displayName)
  const finalSlug = slug.length > 0 ? slug : 'default'
  return `${type}:${finalSlug}`
}
