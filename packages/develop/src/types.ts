/** Shared result / catalogue shapes for CLI + MCP surfaces. */

export interface WorkspacePaths {
  readonly root: string
  readonly packagesDir: string
  readonly capsDir: string
}

export interface AddonCapabilityRef {
  readonly name: string
}

export interface AddonManifestEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly entry: string
  readonly category?: string
  readonly capabilities: readonly AddonCapabilityRef[]
  readonly placement?: string
  readonly group?: string
}

export interface AddonPackageSummary {
  readonly packageName: string
  readonly packageDir: string
  readonly relativeDir: string
  readonly displayName?: string
  readonly description?: string
  readonly addons: readonly AddonManifestEntry[]
}

export interface CapabilitySummary {
  readonly name: string
  readonly file: string
  readonly relativeFile: string
  readonly scope?: string
  readonly mode?: string
  readonly exportName?: string
}

export interface ExampleEntry {
  readonly id: string
  readonly packageDir: string
  readonly kind:
    | 'provider'
    | 'notifier'
    | 'osd'
    | 'post-analysis'
    | 'model-studio'
    | 'admin-ui'
    | 'builtin'
    | 'other'
  readonly demonstrates: string
  readonly tags: readonly string[]
}

export interface ExampleHit {
  readonly example: ExampleEntry
  readonly score: number
  readonly rationale: string
}

export interface ValidationFinding {
  readonly level: 'error' | 'warn' | 'info'
  readonly code: string
  readonly message: string
  readonly path?: string
}

export interface ValidationResult {
  readonly ok: boolean
  readonly findings: readonly ValidationFinding[]
}

export interface ScaffoldAddonOptions {
  readonly workspaceRoot: string
  readonly name: string
  readonly displayName?: string
  readonly description?: string
  readonly directory?: string
  /** Template flavour — empty skeleton, or a stub pointing at a core example. */
  readonly kind?:
    | 'empty'
    | 'provider'
    | 'notifier'
    | 'osd'
    | 'post-analysis'
    | 'model-studio'
    | 'admin-ui'
  readonly dryRun?: boolean
}

export interface ScaffoldAddonResult {
  readonly packageDir: string
  readonly relativeDir: string
  readonly filesWritten: readonly string[]
  /** Every file's content (workspace-relative path), written or not — for a dry-run diff. */
  readonly contents?: readonly { readonly path: string; readonly content: string }[]
  readonly nextSteps: readonly string[]
}

export interface ScaffoldCapOptions {
  readonly workspaceRoot: string
  readonly name: string
  readonly scope?: 'system' | 'device'
  readonly mode?: 'singleton' | 'collection'
  readonly dryRun?: boolean
}

export interface ScaffoldCapResult {
  readonly filePath: string
  readonly relativePath: string
  readonly exportName: string
  readonly nextSteps: readonly string[]
}

export interface ExtendAddonOptions {
  readonly workspaceRoot: string
  /** Package dir, npm name, or short addon id. */
  readonly addon: string
  /** New manifest id / entry stem. */
  readonly entryId: string
  readonly displayName?: string
  readonly description?: string
  readonly dryRun?: boolean
}

export interface ExtendAddonResult {
  readonly packageDir: string
  readonly entryId: string
  readonly filesWritten: readonly string[]
  readonly nextSteps: readonly string[]
}

export interface SkillInfo {
  readonly id: string
  readonly title: string
  readonly absolutePath: string
  readonly relativePath: string
}
