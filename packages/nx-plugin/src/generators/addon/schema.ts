/**
 * Option schema for the CamStack `addon` generator.
 * Mirrors `schema.json` (the Nx-facing JSON schema).
 */
export interface AddonGeneratorSchema {
  /** Addon name (without scope) — folder, package name, manifest id. */
  readonly name: string
  /** Parent directory the package is created in (default: packages). */
  readonly directory?: string
  /** Short marketing description for package.json + admin UI. */
  readonly description?: string
  /** Human-readable name shown in the admin UI. */
  readonly displayName?: string
}
