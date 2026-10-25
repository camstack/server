import { z } from 'zod'

/**
 * `StorageLocationDeclaration` — a single storage-location entry declared by
 * an addon in its `package.json` under `camstack.storageLocations`.
 *
 * Design intent:
 * - **Addon declares its needs** — each addon describes the logical storage
 *   slots it requires (e.g. `recordings`, `recordingsLow`) without caring
 *   about the physical path.
 * - **Kernel aggregates** — at boot the kernel collects declarations from all
 *   installed addons, deduplicates by `id`, and exposes the union via the
 *   storage-locations settings surface.
 * - **Orchestrator seeds** — for every declared `id` the orchestrator ensures
 *   at least one instance named `<id>:default` is present, using
 *   `defaultsTo` to inherit the resolved root from another location when the
 *   declaration is a derivative slot (e.g. `recordingsLow` defaults to
 *   `recordings`).
 * - **ids are global** — `id` values are shared across the entire deployment;
 *   two addons declaring the same `id` must agree on `cardinality` (validated
 *   at kernel aggregation time, not here).
 */
/**
 * `StorageAccess` — how the service that DECLARED a storage-location kind
 * actually reaches the bytes. It is the constraint that decides which
 * `storage-provider`s may back a location of that kind.
 *
 * - `'local-path'` — the service asks `storage.resolve` for a path string and
 *   then does its own `node:fs` I/O on it (the recorder's segment writer, the
 *   post-analysis media roots). Only a provider that serves a genuine local
 *   filesystem (`getProviderInfo().nodeLocal === true`) can satisfy that: a
 *   remote provider's `resolve` returns a path on the REMOTE host, and
 *   `fs.readdir` of it on this node either fails or — far worse — succeeds
 *   against a same-named local directory that is something else entirely.
 *
 * - `'cap-mediated'` — every byte travels through the `storage` cap
 *   (`read`/`write`, or `beginUpload`/`writeChunk`/`finalizeUpload`). The
 *   service never sees a path, so any provider can back it. `backups` is the
 *   one kind that qualifies today.
 *
 * Before this existed, `recordings` was unreachable by SFTP/S3/WebDAV only as
 * an EMERGENT property of how the recorder happened to be written. Nothing
 * refused the configuration; the first write simply went somewhere wrong, and
 * a recording write that goes wrong surfaces as a silent black window rather
 * than an error (the read path does not `stat`). This turns that accident into
 * a declared, enforced, testable refusal.
 */
export const StorageAccessSchema = z.enum(['local-path', 'cap-mediated'])
export type StorageAccess = z.infer<typeof StorageAccessSchema>

/**
 * What an ABSENT `access` means. Fail-closed: a declaration that says nothing
 * is treated as if it does raw filesystem I/O, so a remote provider is
 * refused for it. The permissive value must be written down.
 */
export const STORAGE_ACCESS_FALLBACK: StorageAccess = 'local-path'

export const StorageLocationDeclarationSchema = z.object({
  /**
   * Global location identifier, e.g. `recordings` or `recordingsLow`.
   * Must start with a lowercase letter and may contain letters, digits, and
   * hyphens.
   */
  id: z.string().regex(/^[a-z][a-zA-Z0-9-]*$/, {
    message: 'id must start with a lowercase letter and contain only letters, digits, or hyphens',
  }),

  /** Human-readable name shown in the admin UI. */
  displayName: z.string().min(1, { message: 'displayName must not be empty' }),

  /** Optional longer explanation of what data this location stores. */
  description: z.string().optional(),

  /**
   * `single` — exactly one instance of this location is allowed system-wide
   * (e.g. `logs`, `models`). The operator can edit it but not add more.
   * `multi`  — the operator may register several instances (e.g. a second
   * `recordings` on a NAS for disk tiering); one is the default at any time.
   */
  cardinality: z.enum(['single', 'multi']),

  /**
   * HOW the declaring service reaches the bytes — and therefore WHICH
   * providers may back a location of this kind. See {@link StorageAccessSchema}
   * and {@link STORAGE_ACCESS_FALLBACK}.
   *
   * Absent means `'local-path'`. That default is FAIL-CLOSED on purpose: it
   * can only over-restrict (refuse a remote provider for a kind that might
   * have coped) and never under-restrict. Declaring `'cap-mediated'` is the
   * permissive direction and is therefore never inferred — a repo guard
   * (`scripts/check-storage-access-declarations.ts`) refuses to let it be
   * reached by omission.
   */
  access: StorageAccessSchema.optional(),

  /**
   * When set, the default instance for this location inherits its resolved
   * root from the named location's default instance. Useful for derivative
   * slots (e.g. `recordingsLow` → `recordings`) so operators only need to
   * configure the primary location.
   */
  defaultsTo: z.string().optional(),

  /**
   * Which node root the seeded `<id>:default` instance is placed under on a
   * FRESH install:
   * - `'data'` (default) — the node's data dir (`CAMSTACK_DATA` / boot dir),
   *   the appData volume. Right for small/durable data (logs, models).
   * - `'media'` — the dedicated media volume (`CAMSTACK_MEDIA_ROOT`) when that
   *   env is set, else falls back to the data root. Right for bulky, hot media
   *   (recordings, event media) that should stay off the appData disk.
   * - `'backup'` — the dedicated backup volume (`CAMSTACK_BACKUP_ROOT`, default
   *   `/backups` in the image) so archives live on their own mount rather than
   *   filling the appData disk. Falls back to the data root when unset.
   *
   * Only affects the seeded default's `basePath`; operators can repoint any
   * location afterwards, and a `defaultsTo` slot inherits its parent's root
   * regardless of this field. Absent (the common case) is treated as `'data'`.
   */
  defaultRoot: z.enum(['data', 'media', 'backup']).optional(),
})

/** Inferred TypeScript type for `StorageLocationDeclarationSchema`. */
export type StorageLocationDeclaration = z.infer<typeof StorageLocationDeclarationSchema>
