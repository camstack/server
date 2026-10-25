/**
 * Preference values for core blocks.
 *
 * Schema lives on the block record (`settingsSchema`, extracted from the
 * compiled entry's named export or set by the editor). The VALUES live where a
 * running script reads them and nowhere else: the block addon's own
 * `addon-settings` rows (`core-block-<id>.<field>`, D870), so
 * `ctx.settings.readAddonStore()` answers them like any addon's settings and a
 * settings patch never rewrites the operator's source.
 *
 * A field the block's `settingsSchema` declares `password` / `secret: true` is
 * keychain-backed (D783 / D787), owner = the block's addon id, scope `global`:
 * the row holds the marker, the value lives in the keychain. The block's
 * generated wrapper declares the same schema, so the running script reads the
 * resolved VALUE. A marker is honoured only for its own ref (an incoming marker
 * is never stored - the write path treats it as "keep"), a REDACTED / view
 * value keeps what is stored, and a keychain that cannot take a write refuses
 * it rather than storing plaintext.
 *
 * Before D880 the values were ALSO kept as one blob per block in
 * `core-blocks:settings`: two raw copies of every password. That collection is
 * now LEGACY - read only by {@link BlockSettingsStore.migrateRawSecrets}, which
 * moves the secrets, copies any key the rows lack, and deletes the blob.
 */

import { isDeepStrictEqual } from 'node:util'
import {
  collectSecretMarkerRefs,
  type ConfigUISchema,
  coreBlockAddonId,
  isSecretMarker,
  isSecretRefOwnedBy,
  type RawSecretMigrationReport,
  resolveSecretMarkers,
  type SecretNode,
  type SecretsAccess,
  type SecretTree,
  secretTreeFromSchema,
  type RecordKindHandle,
  type RecordsAccess,
  type SettingsStoreClient,
  transformSecretWrite,
} from '@camstack/types'
import { readAllRows } from '../../records/read-all-rows.js'
import { coreBlocksRecordKinds, type CoreBlockSettingsBodySchema } from './record-kinds.js'
import type { z } from 'zod'

type CoreBlockSettingsBody = z.infer<typeof CoreBlockSettingsBodySchema>
import {
  type AddonSettingsDoor,
  createAddonSettingsStore,
} from '../../kernel/addon-settings-store.js'

/**
 * @durable class=config owner=core-blocks
 *   write="NOTHING since D880 - the values live in the block addon's `addon-settings` rows. Only the one-shot `migrateRawSecrets` reads it, then deletes each row."
 *   retention="legacy: every row is deleted by the verified operator migration; the declaration goes with it once every hub ran it."
 */
export { CORE_BLOCK_SETTINGS_COLLECTION } from './record-kinds.js'

export const CORE_BLOCK_SETTINGS_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'values', type: 'JSON' as const, notNull: true, defaultValue: '{}' },
] as const

/** The keychain door for a given owner, or null when this process has none. */
export type SecretsForOwner = (owner: string) => SecretsAccess | null

export interface BlockSettingsStoreDeps {
  readonly store: SettingsStoreClient
  readonly legacySettings: RecordKindHandle<CoreBlockSettingsBody>
  readonly keychainFor: SecretsForOwner
  /** Told about keychain refs a write dropped but could not delete (they are now orphans). */
  readonly onOrphaned?: (blockId: string, refs: readonly string[]) => void
}

/** The block declares a secret, but this process has no keychain door to put it in. */
export class BlockSecretsUnavailableError extends Error {
  constructor(readonly blockId: string) {
    super(
      `core block "${blockId}" declares a password field, but this process has no keychain door - ` +
        'nothing was saved. Unlock the keychain (System -> Secrets) and save again.',
    )
    this.name = 'BlockSecretsUnavailableError'
  }
}

/** The block addon's settings rows could not be read: never answered as "empty". */
export class BlockSettingsUnreadableError extends Error {
  constructor(
    readonly blockId: string,
    reason: string,
  ) {
    super(`core block "${blockId}": its settings rows cannot be read (${reason})`)
    this.name = 'BlockSettingsUnreadableError'
  }
}

/** One block as the migration sees it. */
export interface BlockSecretsSubject {
  readonly id: string
  readonly settingsSchema?: ConfigUISchema | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface SecretCounts {
  raw: number
  markers: number
}

/** Walk `blob` along the secret `tree`: how many declared secret values are raw / markers. */
function countSecretLeaves(tree: ReadonlyMap<string, SecretNode>, blob: unknown): SecretCounts {
  const counts: SecretCounts = { raw: 0, markers: 0 }
  if (!isRecord(blob)) return counts
  const visit = (node: SecretNode, value: unknown): void => {
    if (node.kind === 'leaf') {
      if (isSecretMarker(value)) counts.markers += 1
      else if (typeof value === 'string' && value.length > 0) counts.raw += 1
      return
    }
    if (node.kind === 'object') {
      if (isRecord(value)) {
        for (const [key, child] of node.children) visit(child, value[key])
      }
      return
    }
    if (Array.isArray(value)) {
      for (const row of value) {
        if (!isRecord(row)) continue
        for (const [key, child] of node.item) visit(child, row[key])
      }
    }
  }
  for (const [key, node] of tree) visit(node, blob[key])
  return counts
}

/** Only the top-level keys the secret tree names (and, when given, `only` holds). */
function secretKeysOf(
  tree: SecretTree,
  blob: Record<string, unknown>,
  only?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of tree.keys()) {
    if (key in blob && (only === undefined || key in only)) out[key] = blob[key]
  }
  return out
}

interface MigrationTally {
  rows: number
  raw: number
  markers: number
  migrated: number
  failed: number
  redundant: number
}

/**
 * Names that LOOK like a credential. Only used on a block whose schema does not
 * declare the field (none, or a partial one): such a value cannot be moved by type,
 * so it is FLAGGED, never copied and never silently dropped.
 */
const CREDENTIAL_NAME =
  /(password|passwd|passphrase|secret|token|api_?key|private_?key|access_?code|credential|cookie|pincode|pin$)/i
const NOT_A_VALUE_SUFFIX =
  /(hash|hashed|fingerprint|count|length|expires|expiry|type|kind|version|status|label|ref|path|id|name)$/i

function holdsRawCredential(value: unknown, depth = 0): boolean {
  if (depth > 8) return false
  if (Array.isArray(value)) return value.some((v) => holdsRawCredential(v, depth + 1))
  if (!isRecord(value) || isSecretMarker(value)) return false
  return Object.entries(value).some(([key, child]) =>
    CREDENTIAL_NAME.test(key) && !NOT_A_VALUE_SUFFIX.test(key)
      ? (typeof child === 'string' && child.length > 0) || holdsRawCredential(child, depth + 1)
      : holdsRawCredential(child, depth + 1),
  )
}

/** Top-level keys the schema does not declare secret that nevertheless hold a raw credential-named value. */
function untrackedCredentialKeys(tree: SecretTree, blob: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  for (const [key, value] of Object.entries(blob)) {
    if (tree.has(key)) continue
    const named = CREDENTIAL_NAME.test(key) && !NOT_A_VALUE_SUFFIX.test(key)
    if (
      (named && typeof value === 'string' && value.length > 0) ||
      (!isSecretMarker(value) && holdsRawCredential(value))
    ) {
      out.add(key)
    }
  }
  return out
}

/** The legacy row's values, tolerating the old bare-blob shape. */
function legacyValuesOf(row: unknown): Record<string, unknown> {
  if (!isRecord(row)) return {}
  const values = row['values']
  if (isRecord(values)) return { ...values }
  return 'values' in row ? {} : { ...row }
}

export class BlockSettingsStore {
  private readonly store: SettingsStoreClient
  private readonly legacySettings: RecordKindHandle<CoreBlockSettingsBody>
  private readonly keychainFor: SecretsForOwner
  private readonly onOrphaned: (blockId: string, refs: readonly string[]) => void

  constructor(deps: BlockSettingsStoreDeps) {
    this.store = deps.store
    this.legacySettings = deps.legacySettings
    this.keychainFor = deps.keychainFor
    this.onOrphaned = deps.onOrphaned ?? (() => undefined)
  }

  static legacyKindOf(
    records: Pick<RecordsAccess, 'kind'>,
  ): RecordKindHandle<CoreBlockSettingsBody> {
    return records.kind(coreBlocksRecordKinds.settings)
  }

  private rows(blockId: string) {
    // The block addon's settings are rows of the one addon-settings store (D870),
    // so no spawn is needed for a read or write to land.
    const store = this.store
    const door: AddonSettingsDoor = {
      query: (input) => store.query.query(input),
      get: (input) => store.get.query(input),
      transact: (input) => store.transact.mutate(input),
    }
    return createAddonSettingsStore(door, coreBlockAddonId(blockId))
  }

  /**
   * The block's stored values - markers, NOT resolved. For the admin form
   * (`hydrateSchema` turns a marker into a "set" view) and as the `stored`
   * side of a write. Absent answers `{}`; an unreadable store THROWS.
   */
  async readStored(blockId: string): Promise<Record<string, unknown>> {
    const read = await this.rows(blockId).read()
    if (read.kind === 'unreadable') throw new BlockSettingsUnreadableError(blockId, read.error)
    return read.kind === 'present' ? { ...read.value } : {}
  }

  /**
   * Patch the block's values. Secret fields (by the schema TYPE) go to the
   * keychain first and the row gets the marker; a keychain that cannot take
   * them refuses the whole patch.
   */
  async mergeValues(
    blockId: string,
    schema: ConfigUISchema | undefined,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const tree = secretTreeFromSchema(schema ?? null)
    if (tree.size === 0) {
      await this.rows(blockId).merge(patch)
      return
    }
    const secrets = this.keychainFor(coreBlockAddonId(blockId))
    if (secrets === null) throw new BlockSecretsUnavailableError(blockId)
    const stored = await this.readStored(blockId)
    const result = await transformSecretWrite({
      tree,
      secrets,
      patch,
      stored,
      operatorWrite: true,
    })
    await this.rows(blockId).merge(result.patch)
    const { orphaned } = await result.afterWrite()
    if (orphaned.length > 0) this.onOrphaned(blockId, orphaned)
  }

  /** The block is gone: its rows, its keychain values and the legacy blob go with it. */
  async delete(blockId: string): Promise<void> {
    const stored = await this.readStored(blockId)
    const owner = coreBlockAddonId(blockId)
    const refs = collectSecretMarkerRefs(stored)
    const removal: Record<string, undefined> = {}
    for (const key of Object.keys(stored)) removal[key] = undefined
    await this.rows(blockId).merge(removal)
    await this.legacySettings.delete(blockId)
    if (refs.length === 0) return
    const secrets = this.keychainFor(owner)
    try {
      await secrets?.delete(refs)
      if (secrets === null) this.onOrphaned(blockId, refs)
    } catch {
      this.onOrphaned(blockId, refs)
    }
  }

  /**
   * D880: move every plaintext secret a block's `settingsSchema` declares into
   * the keychain, and delete the legacy `core-blocks:settings` blob.
   *
   * Per block: gather the values (the addon-settings rows win; a key only the
   * blob holds is carried over), put each secret, READ IT BACK and compare,
   * and only then write the marker. The legacy row is deleted only after the
   * block's rows hold every key it had and every secret resolves. A block that
   * fails stays exactly as it was. Dry run unless `apply`; idempotent; counts
   * only - never a value, a ref or a block id.
   */
  async migrateRawSecrets(
    blocks: readonly BlockSecretsSubject[],
    apply: boolean,
  ): Promise<RawSecretMigrationReport> {
    const legacyById = new Map<string, Record<string, unknown>>()
    for (const row of await readAllRows(this.legacySettings)) {
      legacyById.set(row.id, legacyValuesOf({ values: row.data.values }))
    }

    const tally: MigrationTally = {
      rows: 0,
      raw: 0,
      markers: 0,
      migrated: 0,
      failed: 0,
      redundant: 0,
    }
    const verifyAfter: BlockSecretsSubject[] = []

    for (const block of blocks) {
      const tree = secretTreeFromSchema(block.settingsSchema ?? null)
      const legacy = legacyById.get(block.id)
      const stored = await this.readStored(block.id)
      const effective = { ...legacy, ...stored }
      const counts = countSecretLeaves(tree, effective)
      const untracked = untrackedCredentialKeys(tree, effective)
      if (tree.size > 0 || untracked.size > 0) {
        tally.rows += 1
        if (counts.raw > 0 || untracked.size > 0) tally.raw += 1
        else if (counts.markers > 0) tally.markers += 1
        verifyAfter.push(block)
      }
      const hasLegacy = legacy !== undefined
      if (hasLegacy) tally.redundant += 1
      if (!apply) continue
      const carry = this.carryable(block.id, effective, stored, tree, untracked)
      if (carry.foreign > 0) tally.failed += 1
      if (counts.raw > 0) {
        if (await this.moveBlock(block, tree, carry.rest, effective, stored)) tally.migrated += 1
        else {
          tally.failed += 1
          continue
        }
      } else if (hasLegacy && Object.keys(carry.rest).length > 0) {
        await this.rows(block.id).merge(carry.rest)
      }
      // A legacy blob that holds a credential this run could not verify stays: it is
      // the only copy of it.
      const legacyUntracked = untrackedCredentialKeys(tree, legacy ?? {})
      if (hasLegacy && legacyUntracked.size === 0) await this.dropLegacy(block.id)
    }

    // A legacy row of a block that no longer exists is a raw copy nobody reads.
    const known = new Set(blocks.map((b) => b.id))
    for (const id of legacyById.keys()) {
      if (known.has(id)) continue
      tally.redundant += 1
      if (apply) await this.dropLegacy(id)
    }

    return this.report(apply, tally, verifyAfter)
  }

  /**
   * The keys of the legacy blob that may be copied into the block's rows: not in
   * the rows already, not a secret the tree moves, not a credential-named value no
   * schema declares (flagged instead), and not a marker that points at another
   * owner's secret (counted as `foreign`, never copied).
   */
  private carryable(
    blockId: string,
    effective: Record<string, unknown>,
    stored: Record<string, unknown>,
    tree: SecretTree,
    untracked: ReadonlySet<string>,
  ): { rest: Record<string, unknown>; foreign: number } {
    const owner = coreBlockAddonId(blockId)
    const rest: Record<string, unknown> = {}
    let foreign = 0
    for (const [key, value] of Object.entries(effective)) {
      if (key in stored || tree.has(key) || untracked.has(key)) continue
      if (collectSecretMarkerRefs(value).some((ref) => !isSecretRefOwnedBy(ref, owner))) {
        foreign += 1
        continue
      }
      rest[key] = value
    }
    return { rest, foreign }
  }

  private async dropLegacy(blockId: string): Promise<void> {
    await this.legacySettings.delete(blockId)
  }

  /** put -> read back -> compare -> only then the marker rows. */
  private async moveBlock(
    block: BlockSecretsSubject,
    tree: SecretTree,
    rest: Record<string, unknown>,
    effective: Record<string, unknown>,
    stored: Record<string, unknown>,
  ): Promise<boolean> {
    const secrets = this.keychainFor(coreBlockAddonId(block.id))
    if (secrets === null) return false
    const original = secretKeysOf(tree, effective)
    let written: Awaited<ReturnType<typeof transformSecretWrite>> | null = null
    try {
      written = await transformSecretWrite({
        tree,
        secrets,
        patch: original,
        stored: secretKeysOf(tree, stored),
        operatorWrite: true,
      })
      // Both sides resolved: a field that was already a marker is `keep` in the
      // patch, and a nested object carries a mix of both.
      const back = await resolveSecretMarkers(written.patch, secrets, { unresolved: 'omit' })
      const expected = await resolveSecretMarkers(
        secretKeysOf(tree, original, written.patch),
        secrets,
        {
          unresolved: 'omit',
        },
      )
      if (
        back.unresolved.length > 0 ||
        expected.unresolved.length > 0 ||
        !isDeepStrictEqual(back.value, expected.value)
      ) {
        await this.discard(secrets, written.patch, stored)
        return false
      }
      // Non-secret keys only the legacy blob holds travel in the same write.
      await this.rows(block.id).merge({ ...rest, ...written.patch })
      await written.afterWrite()
      return true
    } catch {
      if (written !== null) await this.discard(secrets, written.patch, stored)
      return false
    }
  }

  /** Remove the values a failed move put, never one the row already pointed at. */
  private async discard(
    secrets: SecretsAccess,
    patch: Record<string, unknown>,
    stored: Record<string, unknown>,
  ): Promise<void> {
    const had = new Set(collectSecretMarkerRefs(stored))
    const fresh = collectSecretMarkerRefs(patch).filter((ref) => !had.has(ref))
    if (fresh.length === 0) return
    try {
      await secrets.delete(fresh)
    } catch {
      /* an orphan the Secrets page shows; never re-pointed at */
    }
  }

  private async report(
    apply: boolean,
    tally: MigrationTally,
    subjects: readonly BlockSecretsSubject[],
  ): Promise<RawSecretMigrationReport> {
    let remainingRaw = 0
    let unresolvedMarkers = 0
    const legacyById = new Map<string, Record<string, unknown>>()
    for (const row of await readAllRows(this.legacySettings)) {
      legacyById.set(row.id, legacyValuesOf({ values: row.data.values }))
    }
    for (const block of subjects) {
      const tree = secretTreeFromSchema(block.settingsSchema ?? null)
      const after = await this.readStored(block.id)
      const counts = countSecretLeaves(tree, after)
      remainingRaw += counts.raw
      // Credential-named values no schema declares: unverified, still raw. A key the
      // legacy blob also holds is counted once, below.
      const legacyKeys = legacyById.get(block.id) ?? {}
      for (const key of untrackedCredentialKeys(tree, after))
        if (!(key in legacyKeys)) remainingRaw += 1
      if (counts.markers === 0) continue
      const secrets = this.keychainFor(coreBlockAddonId(block.id))
      if (secrets === null) {
        unresolvedMarkers += counts.markers
        continue
      }
      const resolved = await resolveSecretMarkers(secretKeysOf(tree, after), secrets, {
        unresolved: 'omit',
      })
      unresolvedMarkers += resolved.unresolved.length
    }
    // A legacy blob that still holds a raw secret counts as raw too.
    const bySchema = new Map(subjects.map((b) => [b.id, b.settingsSchema]))
    for (const [id, values] of legacyById) {
      const tree = secretTreeFromSchema(bySchema.get(id) ?? null)
      remainingRaw +=
        countSecretLeaves(tree, values).raw + untrackedCredentialKeys(tree, values).size
    }
    return {
      apply,
      rows: tally.rows,
      raw: tally.raw,
      markers: tally.markers,
      migrated: tally.migrated,
      failed: tally.failed,
      remainingRaw,
      unresolvedMarkers,
      redundantCopies: tally.redundant,
      verified: remainingRaw === 0 && unresolvedMarkers === 0,
    }
  }
}
