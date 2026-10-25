---
id: D298
title: "A storage KIND declares how its service reaches the bytes; a provider that cannot satisfy it is REFUSED"
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/types/src/interfaces/storage-location-declaration.ts
  - packages/system/src/kernel/storage-location-registry.ts
  - packages/system/src/builtins/storage-orchestrator/access-guards.ts
  - packages/system/src/builtins/storage-orchestrator/location-secrets.ts
  - packages/addon-remote-storage/src/providers/smb/smb-provider.ts
---

## Context

`recordings`, `eventMedia` and `galleryMedia` were unreachable by SFTP, S3 and
WebDAV. Not by rule — by accident of how their services were written.

The recorder does not do I/O through the `storage` cap. It calls
`storage.resolve` once for an absolute string and then does raw `node:fs` on it
(`packages/addon-pipeline/src/recorder/addon/roots.ts:177`, then
`path.join` + `fs.readdir` at `roots.ts:475`). Post-analysis does the same for
event media (`packages/addon-post-analysis/src/pipeline-analytics/index.ts:2740`),
for media relocation (`index.ts:2979`) and for the gallery (`index.ts:5004`).
The SFTP provider's `resolve` returns `safeJoinRemotePath(cfg.basePath, …)` —
a path on the REMOTE host
(`packages/addon-remote-storage/src/providers/sftp/sftp-provider.ts:298`).

So nothing refused a `recordings` location on SFTP. It could be created, it
would be selected as a write target, and the first `fs.readdir` would run
against a hub-local directory that either does not exist or exists and is
something else. The recorder's read path does not `stat`
(`packages/addon-pipeline/src/recorder/addon/recording-provider.ts:211`), so
the operator's symptom is not an error — it is a black window in the footage,
and the durable ledger says the segment is there (D291, D295).

An emergent protection is one that holds until someone reasonable does
something reasonable. Three remote providers already ship; a fourth (SMB) was
being added.

Two adjacent findings, both of which this record also closes:

- **`locationOccupancy` reads an unreachable location as `empty`.** Its own
  docblock said remote locations answer `unknown`; the code did not do it. It
  read `config.basePath` — for a remote location a plain-looking string like
  `/backups/camstack` — `readdir`ed it on the hub, got `ENOENT`, and `ENOENT`
  is deliberately `empty` because for a LOCAL location an absent root means
  there is nothing a delete can strand. Applied to a remote row that reasoning
  turns a full share into a vacant one, and D293's delete guard passes. The
  comment describing the right design read as verification for six months.
- **`storage.listLocations` returns every location's config verbatim, with no
  `auth` override** (`packages/types/src/capabilities/storage.cap.ts:129`), so
  every authenticated session — not only an admin — could read every stored
  credential. Nothing is exposed today only because all six live locations are
  `filesystem-storage`, whose config is `basePath` + `maxUsedGb`. It becomes
  exposed with the first remote location.

## Decision

**A storage-location KIND declares `access`, and the orchestrator refuses a
provider that cannot satisfy it.**

`StorageLocationDeclaration.access` is one of:

- `'local-path'` — the declaring service reads and writes with `node:fs` on
  the path `storage.resolve` returns. Only a provider whose
  `getProviderInfo().nodeLocal` is `true` may back it.
- `'cap-mediated'` — every byte travels through the `storage` cap. Any
  provider may back it. `backups` is the only kind that qualifies today.

**Absent means `'local-path'`.** The default is fail-closed: it can only
over-restrict, never under-restrict, so a declaration that says nothing keeps
the recorder's kinds safe with no manifest edit. The PERMISSIVE value is never
inferred — it is written down or it does not apply.

`nodeLocal` is the provider-side half of the constraint. It already means
exactly "this provider's `resolve` returns a path on the filesystem of the node
that resolved it", every provider is already forced to declare it by the
`storage-provider` cap's discriminated union, and all four remote providers
declare `false`. No new cap surface, no codegen.

Three locks, in the order they are reached:

1. **`upsertLocation` refuses** the pairing at the moment an operator makes it.
2. **`storage.resolve` refuses** on a location backed by a remote provider —
   the trap itself, closed rather than documented.
3. **`locationOccupancy` answers `unknown`** for anything not backed by a local
   filesystem, so unreachable can never present as empty.

All three are three-valued and only a POSITIVE `false` refuses. `undefined`
means the provider has not registered yet, which is unknown, not remote — and a
conclusion drawn from a read that was never made is D49's failure mode. The
same applies to the declaration side: an undeclared KIND is `local-path`
(fail-closed), but NO REGISTRY AT ALL is not evaluated, because nothing has
been loaded to conclude from.

**And a prerequisite that ships first: credentials are redacted from
`listLocations` / `getDefaultLocation`, driven by each provider's own
`configSchema`.** The discriminator is `type === 'password' || secret === true`
— NOT `type: 'password'` alone, which would have missed the SFTP provider's
`privateKey`, a complete PEM key in a `textarea`. A redaction that quietly
misses a credential is worse than none: it is a leak plus an assurance there is
not one. The sentinel travelling back in on an upsert means "keep what is
stored".

## Consequences

**What it forbids.** A `recordings`, `recordingsLow`, `eventMedia` or
`galleryMedia` location on SFTP, S3, WebDAV or SMB. Loudly, at creation. If
those kinds are ever to live on remote storage, the work is to stop
`storage.resolve` + raw `fs` being the media contract — not to relax this.

**What it costs.** A kind that genuinely is cap-mediated must say so or it is
refused. Exactly one declaration needed the word: `backups`, in
`packages/system/package.json`.

**What has to stay true.** `nodeLocal` must keep meaning what it says. A
provider that declared `true` to obtain statfs-backed capacity would now
disable a safety constraint rather than gain a convenience;
`provider-info.spec.ts` asserts all four remote providers declare `false`.

**Not addressed.** A node-local location on ANOTHER node still resolves to a
path this node cannot open. That hazard predates this record and is unchanged
by it; the recorder runs on the node that owns its locations, so it is latent.
It should be closed the same way when multi-node recordings land.

**Also not addressed: two SMB locations on one share.** Each would run its own
retention sweep against a manifest the other rewrites, and the failure surfaces
at restore time on a file the manifest swears is present.
`SmbStorageProvider.findDuplicateShare` implements and tests the identity rule
— `(host, share, basePath)`, case-insensitive — but **nothing calls it**:
`storage.testConfig` cannot see sibling locations, and reaching a
provider-specific method from the orchestrator's generic dispatch needs a new
method on the `storage-provider` cap. It ships as a predicate because the
identity rule is the part that is easy to get wrong; the plumbing belongs with
the cap change that carries it.

**Also not addressed.** `physicalRootKey`
(`packages/addon-pipeline/src/recorder/addon/eviction-domain.ts:33`) falls back
to a lexical path string when `realpath` throws, and its comment promises that
can only over-partition, never merge. That promise holds only because the
function has never been handed a non-local path — which this record is what
keeps true. It becomes a live bug the day a remote provider serves recordings,
and must be fixed before then, not with it.

## Enforcement

- `scripts/check-storage-access-declarations.ts`, wired into the CI repository-
  guards loop. Validates the value, refuses a `cap-mediated` that was inferred
  rather than declared, refuses two addons disagreeing on one kind's effective
  access, and refuses a `defaultsTo` derivative that crosses access classes.
- `buildStorageLocationRegistry` throws on an access conflict at boot, the same
  way it already throws on a cardinality conflict. First-declarer-wins is right
  for a display name and catastrophic for a safety constraint.
- Tests: `storage-access-constraint.spec.ts` (the refusal, asserted three
  independent ways so "refused" cannot pass as "accepted, then failed"),
  `access-guards.spec.ts` (locks 2 and 3), `location-secrets.spec.ts` (the
  textarea-secret miss), `smb-provider.spec.ts`.

## Related

- D293 — a location is deleted only after it is verified empty; unreachable is
  not empty. Lock 3 is what keeps that guard honest for a remote row.
- D291, D295 — the durable row is believed over the disk, which is why a
  misdirected recording write is silent.
- D49 — a gate never fires on a read that failed; why `undefined` permits.
- `docs/design/2026-08-30-smb-storage-provider.md` — the design this
  implements, and the sections of it this supersedes.
