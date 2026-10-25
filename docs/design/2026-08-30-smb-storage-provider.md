---
title: An SMB/CIFS storage location — a fourth entry in remote-storage, scoped to backups
date: 2026-08-30
status: proposed
---

# An SMB/CIFS storage location

**Plan only. No source file is claimed here** — hence neither `covers:` nor
`applies-to:` (D145: a plan that arms the ratchet on code it did not write
destroys the ratchet).

> **STATUS, later the same day: implemented, with two sections SUPERSEDED.**
> See [D296](../decisions/adr-0298-a-storage-kind-declares-how-it-reaches-its-bytes-and-a-provider-that-cannot-is-refused.md)
> and [D297](../decisions/adr-0297-a-host-binary-an-addon-needs-is-declared-in-the-manifest-not-installed-by-the-addon.md).
>
> - **SUPERSEDED — §1 Option B's dependency objection, §7 Stage 2's opening
>   spike, and §8's first two bullets.** The answer was never a JavaScript SMB
>   client. It is `samba-client@^7.2.0`, a maintained wrapper around the
>   **`smbclient` binary** — Samba's own tool, maintained by the people who
>   define the protocol — which the operator has been running in production
> against this same NAS through his `the reference plugin` plugin. No spike
>   was needed and none was run. Marked rather than deleted: the reasoning that
>   rejected the abandoned JS forks is still correct, and it is *why* the
>   binary route was taken.
> - **SUPERSEDED — §1's "ship Option A first".** Option B ships. The binary
>   arrives through the manifest's `systemDependencies` (D297) — no Dockerfile
>   change, no image rebuild, no container recreate.
> - **§0.3 is no longer a description of an accident.** It is the declared
>   `access` constraint (D296): a kind states whether its service does raw
>   `node:fs` on `storage.resolve`, and a remote provider is REFUSED for the
>   ones that do — at upsert, at `resolve`, and in the occupancy probe.
> - **§4's `locationOccupancy` hazard is CLOSED**, not merely named: anything
>   not backed by a local filesystem answers `unknown`.
> - **§5's redaction is implemented, and falsifier §9.5 was CONFIRMED.** The
>   SFTP `privateKey` is a `textarea` holding a full PEM key, so
>   `type: 'password'` alone would have missed it and given false assurance.
>   The discriminator is `type === 'password' || secret === true`.
> - **§3's verify-on-finalize is implemented** in the provider.
> - **§2's duplicate-share refusal is implemented** as
>   `SmbStorageProvider.findDuplicateShare`.

First use: back the camstack server up onto the operator's Unraid backup share.

---

## 0. The three findings that reshape the request

Before any design, three things the codebase already settles.

### 0.1 A backup destination IS a `backups` storage location. There is no second subsystem.

`backup-orchestrator` does not own a destination registry. It calls
`api.storage.listLocations.query({ type: 'backups' })` and treats **every**
returned row as a destination
(`packages/system/src/builtins/backup-orchestrator/backup-orchestrator.addon.ts:334`),
joining it with its own `backup_destination_policies` table only for
`enabled` / `retentionCount` / `label` / `cron`
(`backup-orchestrator.addon.ts:309`). The archive bytes travel over the
consumer-facing `storage` cap's chunked upload — `beginUpload` / `writeChunk` /
`finalizeUpload` (`backup-orchestrator.addon.ts:603`) — and retention deletes go
through `storage.delete` (`backup-orchestrator.addon.ts:654`).

`backup.listDestinations`, `backup.upsertDestinationPolicy` and
`backup.listSchedules` are therefore a *policy* surface over storage locations,
not a parallel storage abstraction. `BackupDestinationInfoSchema`'s own comment
says the label "overrides storage location displayName"
(`packages/types/src/capabilities/backup.cap.ts:61`).

**Consequence:** the work is a `storage-provider` and nothing else. A new SMB
provider becomes a selectable backup destination the moment an operator creates
a `backups:<slug>` location on it. Zero lines in the backup subsystem.

### 0.2 The addon already exists, and it already has three siblings.

`@camstack/addon-remote-storage` ships **three** manifest entries —
`sftp-storage`, `s3-storage`, `webdav-storage` — each registering one
`storage-provider` collection provider, all from one npm package, all in
`execution.group: "remote-storage"`. The split is forced: `CapabilityRegistry`
keys collection providers by `addonId`, so N providers under one addon id
collapse to one (`packages/addon-remote-storage/src/index.ts:7`).

SMB is a **fourth entry in that package**. Not a new package, not a new
capability. The SFTP provider is the template: a session-pooled, remote,
POSIX-path backend with `.partial` → rename finalize
(`packages/addon-remote-storage/src/providers/sftp/sftp-provider.ts:492`).

### 0.3 `recordings` / `eventMedia` / `galleryMedia` are not reachable by *any* remote provider today — SMB included.

This is the finding that decides most of the rest of the document, and it is not
about SMB.

The recorder does not do I/O through the `storage` cap. It calls
`storage.resolve` **once** to get an absolute string and then does raw
`node:fs` on it:

```
root: await api.storage.resolve.query({ location: l.id, relativePath: '' })
```
(`packages/addon-pipeline/src/recorder/addon/roots.ts:177`) — after which
`path.join(root, String(deviceId))` and `fs.readdir` (`roots.ts:475`).
Post-analysis does the same for `eventMedia` (`resolveRoot`,
`packages/addon-post-analysis/src/pipeline-analytics/index.ts:2740`), for media
relocation (`index.ts:2979`) and for `galleryMedia` (`index.ts:5004`).

The SFTP provider's `resolve` returns
`safeJoinRemotePath(cfg.basePath, relativePath)` — a **remote** path string
(`sftp-provider.ts:298`). Handing that to `fs.readdir` on the hub reads a
local directory that either does not exist or, worse, exists and is something
else.

**So:** SFTP, S3 and WebDAV cannot hold recordings or event media *today*, and
neither can SMB. The only classes a remote `storage-provider` actually serves
are the ones that route every byte through the cap. Today that is `backups`.

The prompt asks to "be explicit that `recordings` at 5.8 Mbps × 30 writers is a
different proposition from a nightly backup." It is a different proposition, and
it is also **not currently on the table for any remote provider** — the blocker
is the resolve-then-raw-fs contract, not SMB's write semantics. SMB's write
semantics are why it would still be wrong *after* that blocker is removed. Both
statements are needed; only the second is usually said.

---

## 1. Where the mount lives: kernel or userspace

The two options are not two implementations of one feature. They reach
**different sets of storage classes** and cost different amounts of code.

### Option A — host `mount -t cifs`, `filesystem-storage` on the mountpoint

**Zero new code.** The operator mounts the Unraid share on the host, bind-mounts
it into the hub container, and creates a `backups:unraid` location with
`providerId: "filesystem-storage"` and `basePath` = the mountpoint. It is
`nodeLocal: true`, so the orchestrator stamps `nodeId` (defaulting to `hub`,
`packages/system/src/builtins/storage-orchestrator/storage-orchestrator.service.ts:541`).

- **Reaches every class**, including `recordings`, because `resolve` returns a
  genuine local path that `fs.readdir` can walk.
- `statfs` works, so `capacity`, `minFreePercent` and the drain headroom guard
  all report real numbers.
- **What breaks when the share is unreachable:** the kernel's CIFS client. With
  the default (hard) mount, an I/O call **blocks in uninterruptible sleep**
  rather than erroring. A blocked `fs.statfs` inside `localCapacityOf`
  (`storage-orchestrator.addon.ts:588`) hangs `storage.listLocations`, which
  hangs the admin Data screen and `backup.listDestinations`. `soft,retrans=…`
  converts that into `EIO` instead, which the code paths handle far better.
  This is the specific reason a CIFS mount for camstack should be `soft`, not
  the default.
- **The lifecycle cost the prompt names is real:** camstack does not own the
  mount. A host reboot ordering issue, an Unraid array stop, a `fstab` typo —
  camstack finds a *local directory that exists and is empty*. On `backups`
  that writes an archive to the container's own disk under the impression it
  went to the NAS. On `recordings` it is worse: `locationOccupancy` reads
  `ENOENT` as `empty`, deliberately (`storage-orchestrator.addon.ts:687`), so a
  location on an unmounted share can be **deleted** past the safety check.
- Inside a container it needs `SYS_ADMIN` (or a host-side mount bind-propagated
  in). The shipped `docker-compose.yml` grants no `cap_add` and is not
  `privileged`, so an in-container mount is not available as configured — the
  mount must be host-side.

### Option B — userspace SMB client in the provider process

Self-contained, no host dependency, mount state is camstack's own.

- **Reaches only cap-mediated classes** — i.e. `backups`. `resolve` returns a
  remote path, per §0.3.
- **What breaks when the share is unreachable:** exactly one addon runner. A
  `beginUpload` or `writeChunk` rejects, `uploadArchive` catches, calls
  `abortUpload` and rethrows (`backup-orchestrator.addon.ts:628`). The archive
  is not appended to `manifests.json`, so the destination correctly reports no
  new backup. `storage.listLocations` does not touch the provider at all — it
  only `statfs`es local `basePath`s — so **the Data screen and the destinations
  table stay responsive**. This is a materially better blast radius than
  Option A's hard mount.
- **SUPERSEDED (see the status note at the top).** The dependency objection
  below applies to a *JavaScript* SMB client, and no JavaScript SMB client was
  used. `samba-client@^7.2.0` wraps the `smbclient` BINARY. The paragraph is
  kept because it is why that route was chosen.
- **The dependency is the problem.** Every JS SMB client on npm is a fork of
  the abandoned `@marsaud/smb2` (last publish 2022-06-12). `v9u-smb2@1.0.6`
  was last modified 2022-08-22; `@tryjsky/v9u-smb2@1.1.0`, described as
  "v9u-smb2 with Node v17 patch", 2023-06-30. These are SMB2-dialect,
  NTLM-only, unmaintained. Node 24 is well past what any of them was tested
  against. That is a new failure surface with no upstream.

### The decision

**Ship Option A as the supported path for the first use, and treat Option B as
the thing that must earn its way in.**

Concretely: the operator can have an SMB-backed nightly backup **today**, with
no code, by host-mounting the Unraid share `soft` and pointing a
`filesystem-storage` `backups:unraid` location at it. That is the smallest thing
that works, and it is smaller than any code.

Option B — a real `smb-storage` provider — is worth building because it removes
the "camstack does not own its mount" class of failure and gives a
credential-carrying, testable-from-the-UI location. But it should be built
knowing that (a) it buys nothing Option A cannot do for `backups`, and (b) its
dependency is a 2023 fork. The honest framing is: **Option B is a robustness and
operability improvement over Option A, not a capability improvement.**

If Option B is built, §3 is its shape.

---

## 2. `nodeLocal` — an advantage the model supports, and the writer it must refuse

An SMB share is reachable from every node. `StorageLocation.nodeId` is optional
and documented as "REQUIRED for node-local providers … null/absent for
node-agnostic providers (S3/SFTP/WebDAV, reachable from any node)"
(`packages/types/src/interfaces/storage-location.ts:61`). The orchestrator's
`nodeLocalResolver` stamps `nodeId: 'hub'` **only** when the provider declares
`nodeLocal: true` (`storage-orchestrator.service.ts:541`), and the backfill
skips node-agnostic rows entirely (`storage-orchestrator.service.ts:394`).

So the model already supports it, and the two options land on opposite sides:

| | `nodeLocal` | `nodeId` | Reachable from |
| --- | --- | --- | --- |
| **A** — CIFS mount + `filesystem-storage` | `true` | stamped `hub` | the node that has the mount |
| **B** — `smb-storage` userspace | `false` | absent | any node running the provider |

**Is node-agnosticism an advantage or two writers on one share?** It is both, and
which one you get is decided by *the location record*, not the provider.

- **One location, many nodes** — this is the advantage, and it is safe for
  `backups`. Every archive filename is unique
  (`<id>` from `randomUUID`), the fan-out is orchestrated by a single
  `backup-orchestrator` singleton on the hub, and the per-location
  `manifests.json` is written under `LocationManifestLock`
  (`packages/system/src/builtins/backup-orchestrator/manifest-store.ts`). One
  writer in practice.
- **Two locations, same share** — this is the hazard, and nothing stops an
  operator creating `backups:unraid-a` and `backups:unraid-b` with identical
  `host` + `share` + `basePath`. Each gets its own retention policy. Each
  independently rewrites `manifests.json`. The second one's retention sweep
  deletes archives the first one still lists → the first destination's table
  shows archives that no longer exist, and `restore` fails on a file the
  manifest swears is there.

**What the provider must refuse:**

1. **`upsertLocation` must reject a second location whose
   `(host, share, normalized basePath)` triple already belongs to a live
   location.** Case-insensitively for host and share (SMB is), after normalising
   the path. This check does not exist today for *any* provider — the
   `physicalRootKey` aliasing machinery (§4) is recordings-only and local-only.
   For the first cut this is a provider-side check inside `testLocation`
   returning `{ ok: false, error }`, which the wizard already surfaces; a real
   orchestrator-level uniqueness guard is a framework change and is listed in
   §7 as *not* in the first cut.
2. **`nodeLocal: false` must be declared honestly.** Declaring `true` to obtain
   `statfs`-backed capacity would make the orchestrator stamp a `nodeId` and
   pin the location to one node for no reason — and would be a lie the
   discriminated union in `packages/types/src/capabilities/storage-provider.cap.ts:24`
   is specifically shaped to prevent.

---

## 3. Failure modes, and which classes are therefore safe

### What SMB does that a local filesystem does not

- **Disconnects mid-write.** A session drops between `writeChunk` calls. The
  `.partial` file is left behind; the next call fails on a dead handle.
- **Partial writes.** An SMB2 WRITE can return fewer bytes than requested. A
  client that ignores the returned count silently truncates.
- **Stalls.** No timeout on the request → the promise never settles → the upload
  session's 5-minute idle timer
  (`packages/addon-remote-storage/src/shared.ts:17`) fires and aborts under a
  call that is still notionally in flight.
- **No `fsync` you can trust.** SMB2 has `FLUSH`, but whether it reaches the
  server's platters depends on the server, on oplocks/leases, and on write-behind
  caching. A `close` that returns is not a durability statement.
- **`rename`-over-existing is not universally permitted**, which is why the SFTP
  provider unlinks the target first (`sftp-provider.ts:500`). The same
  best-effort unlink-then-rename applies, and it means the finalize is **not
  atomic**: a crash between unlink and rename destroys the previous archive
  without landing the new one.

### Why `backups` survives all of that and `recordings` does not

The whole difference is **who notices, and what is lost if nobody does.**

| | `backups` | `recordings` |
| --- | --- | --- |
| Writer count | 1 (hub singleton) | 30 concurrent |
| Rate | one archive, nightly | 5.8 Mbps × 30 ≈ 174 Mbps sustained |
| A failed write costs | tonight's archive; yesterday's is intact | a permanent hole in footage |
| Failure is observable | yes — `manifests.json` never gains the entry, the destination row keeps its old `lastSuccessAt` | **no** — the read path does not `stat` (`packages/addon-pipeline/src/recorder/addon/recording-provider.ts:211`), so a missing segment renders as a silent black window |
| Retry | trivial: run it again | impossible: the frames are gone |

That last row is the argument. D291 orders copy → **verify** → durable repoint →
delete precisely because the recorder's durable index is believed over the disk;
a write that "returned" but did not land produces a ledger row pointing at
nothing, and the operator sees black, not an error. Layering SMB's
un-trustworthy `close` under that is how you manufacture the 2 131-ghost-segment
shape D291 exists to prevent.

For `backups` the equivalent risk is bounded and *visible*: the manifest is only
appended after `finalizeUpload` resolves (`backup-orchestrator.addon.ts:624`
then `backup-orchestrator.addon.ts:670`), so a failed upload leaves the
destination honestly reporting its previous newest archive.

### The one gap in `backups`, and the cheap fix

`finalizeUpload` returning is currently trusted. There is **no checksum
anywhere** in the backup path — `ManifestArchiveEntry` carries `sizeBytes` and
nothing else (`manifest-store.ts:154`), and restore only detects an empty chunk
mid-stream (`packages/system/src/builtins/backup-orchestrator/download-helpers.ts:50`).

The provider can close most of that gap **without a cap change**, because
`beginDownload` already returns the file's size:

> **Verify-on-finalize.** After the rename, `smb-storage.finalizeUpload` stats
> the target and compares the byte count against the session's
> `bytesWritten`. A mismatch throws — the caller's existing `catch` calls
> `abortUpload` and the manifest is never appended.

This is a **provider-internal** obligation, costs one round-trip per nightly
archive, and turns "the server said close succeeded" into "the server says the
file is that many bytes". It does not prove the bytes are *correct* — that needs
a checksum, which is a `backup` cap change and is out of scope (§7).

**Verdict per class:**

| Class | On SMB |
| --- | --- |
| `backups` | **Safe**, with verify-on-finalize. The first use. |
| `galleryMedia` | Blocked by §0.3. Would be plausible after that, low rate, but a lost enrolment crop is silently lost. |
| `eventMedia` | Blocked by §0.3. Bursty, and D58 already fights media that fails to land. |
| `recordingsLow` | Blocked by §0.3, and would still be wrong: same silent-black-window failure as `recordings`, at lower bitrate. |
| `recordings` | **No.** Not until a mid-write disconnect has been faced deliberately, and not before §7's staging-and-verify writer exists. |

---

## 4. What today's code would do wrong

Each of these is a real code path, and each one's failure mode is *quiet*.

### `physicalRootKey` — safe by construction, for the wrong reason

`physicalRootKey(root)` is `path.resolve` then `fs.realpathSync`, falling back
to the resolved string when realpath throws
(`packages/addon-pipeline/src/recorder/addon/eviction-domain.ts:33`). Its own
doc comment states the fallback "can only ever OVER-partition (treat one disk as
two), never MERGE two different disks".

- **Option A, share mounted:** realpath resolves through the mountpoint
  normally. Correct.
- **Option A, share NOT mounted:** realpath throws (`ENOENT`) → the lexical path
  string. Two locations under the same missing mount still share a string and
  still merge into one eviction domain. Correct-ish, and safely so.
- **Option B:** `basePath` is a *remote* path like `/backups/camstack`. realpath
  throws → the lexical string. Two SMB locations on **different servers** with
  the same `basePath` collapse to **one** key. That is the merge direction the
  comment promises cannot happen — and the promise is true only because the
  function has never been handed a non-local path.

This is latent, not live: `physicalRootKey` is called only from
`relocate-engine.ts:354` and `recording-provider.ts:875`, both recordings-only,
and §0.3 keeps remote providers out of recordings. **It becomes a live bug the
day a remote provider serves recordings, and it must be fixed before then, not
with it.**

### `getLocationDeviceKey` — returns a meaningless-but-harmless key

`locationDeviceKey` is `fs.realpath(basePath)` falling back to
`path.resolve(basePath)` (`storage-orchestrator.addon.ts:654`). For an SMB
location it returns the lexical remote path. It feeds the pressure manager's
in-sweep dedup (`storage-pressure-manager.ts:73`). Two SMB locations with the
same `basePath` on different servers dedup as one — but the pressure manager
only ever acts on locations whose free-percent it could read, and §"minFreePercent"
below shows it cannot read one for SMB. Harmless today, same latent shape.

### `minFreePercent` / `statfs` — the guard silently disables itself

`locationFreePercent` returns **100 when `statfs` throws**
(`storage-orchestrator.addon.ts:709`): "100 (guard inert) when unstattable".
`localCapacityOf` returns `null` (`storage-orchestrator.addon.ts:588`), and
`listLocations` reports `capacity: null` — honest.

> **WRONG, measured 2026-09-13 and fixed by
> [D488](../decisions/adr-0488-a-locations-capacity-is-a-measurement-of-its-own-volume-or-it-is-unknown.md).**
> `localCapacityOf` did NOT return `null` for the shipped SMB location. Its
> `basePath` is `"camstack"` — relative to the share — and the probe resolved
> it against the hub process's cwd, then walked up to the nearest existing
> ancestor and `statfs`'d the container root. `storage.listLocations` handed
> `backups:smb` byte-identical capacity to `backups:default`
> (`total=506107977728 avail=193348673536` for both), and the Storage page drew
> two identical bars. The capacity probe now refuses any location whose
> provider is not KNOWN node-local; `locationFreePercent` reads that same
> probe, so its "guard inert" branch is now reached for the right reason rather
> than by a throw that never came.

For Option B the provider declares `shouldSaveDiskSpace: false` /
`minFreePercent: null`, matching SFTP (`sftp-provider.ts:201`) and S3, and
`getAvailableSpace` returns `null` (`sftp-provider.ts:418`). That is the
truthful answer and the schema is built for it
(`storage-provider.cap.ts:37`). **The share's real free space is invisible to
camstack**, so a full NAS surfaces as a write error, never as a pre-emptive
refusal.

> SMB2 *does* expose `FSCTL_QUERY_FS_FULL_SIZE_INFO`, so a real free-space
> number is technically obtainable. Whether the chosen npm fork exposes it is
> unverified (§8). Do **not** declare `shouldSaveDiskSpace: true` on a hope: the
> discriminated union then demands a concrete `minFreePercent`, and a provider
> that promises a threshold it cannot measure is worse than one that admits it
> cannot.

For Option A `statfs` on a CIFS mountpoint **does** work and returns the
server's numbers — one of Option A's genuine advantages, and the reason
`recordings` on a CIFS mount is a coherent idea in a way `recordings` on Option B
is not.

### The drain headroom refusal — already correct, and already loud

`headroomRefusal` treats an unreadable free-percent as "drain anyway" and logs
`'relocate: destination free space is UNREADABLE — draining anyway, a full disk
will surface as ENOSPC'` (`packages/addon-pipeline/src/recorder/relocate-engine.ts:517`).
That is the right call and it is logged, so no change is needed — but it means a
drain **into** an SMB destination has no headroom protection at all. Another
reason the drain path is not part of this work.

### The migration co-location guard

`rootsPhysicallySame` falls back to comparing `stat().dev`/`ino` when the
`physicalRootKey` strings differ (`relocate-engine.ts:354`). Both `fs.stat` calls
throw for a remote path → `catch` → `false` → the drain treats source and
destination as different disks and applies the headroom check. Correct default
for a remote target; no change.

---

## 5. Credentials

The repo's scar is exact and it is **already reproduced here**.

`StorageLocation.config` is `z.record(z.string(), z.unknown())`
(`packages/types/src/interfaces/storage-location.ts:53`).
`storage.listLocations` carries **no `auth` override**
(`packages/types/src/capabilities/storage.cap.ts:129`), so per
`docs/architecture/capabilities.md` it is born `protected` — reachable by every
authenticated non-admin. The orchestrator's implementation spreads the row
verbatim and adds `capacity`; it redacts nothing
(`storage-orchestrator.addon.ts:158`).

The SFTP config schema already declares `password`, `privateKey` and
`privateKeyPassphrase` (`packages/addon-remote-storage/src/providers/sftp/sftp-config-schema.ts:52`).
`type: 'password'` makes the **admin UI** render a masked input; it does not
redact the wire. **Today, any authenticated session can read the SFTP password
of every configured location.** Same shape as `deviceExport.getStatus` returning
an Alexa ingress token in the clear and `provider-reolink`'s
`emailPushAuthPassword` (`packages/addon-provider-reolink/src/email-push-schema.ts:105`).

Adding SMB credentials to that surface makes an existing hole one entry wider.
So:

### Where SMB credentials live

In `StorageLocation.config`, like every other provider. There is no secret store
to move them to, and inventing one for this feature is exactly the "smallest
thing that works" violation. Fields: `host`, `share`, `domain`, `username`,
`password` (`type: 'password'`), `basePath`.

### What the read surface must return

**A field-level redaction in the orchestrator, applied on the way out of
`listLocations` and `getDefaultLocation`.** Not in the provider — the provider
does not see the read path.

The mechanism should not be a hardcoded key list. Every provider already ships a
`ConfigUISchema` via `getProviderInfo().configSchema`, and that schema already
declares which fields are `type: 'password'`. The orchestrator resolves the
provider for a row, walks its config schema, and replaces every
`type: 'password'` field's value with a sentinel — writing back the sentinel on
`upsertLocation` means "keep what is stored", which is the standard
edit-without-retyping pattern the wizard needs anyway.

This is a **framework change** (`packages/system`, possibly `packages/types`),
it fixes SFTP/S3/WebDAV at the same time, and it is the one part of this work
that is not shippable by `camstack deploy`. It is listed accordingly in §6.

**It is also a hard prerequisite for the SMB provider, not a follow-up.** Adding
a credentialed provider to a surface known to leak credentials is not a smaller
change; it is the same change with the security part deferred.

### How `testConfig` avoids echoing them

`storage.testConfig({ providerId, config })` (`auth: 'admin'`) dispatches to the
provider's `testLocation` and returns whatever it produces
(`storage-orchestrator.addon.ts:205`). The result schema is
`{ ok, error?: string }` — a free-text string that goes straight back on the
wire.

Three rules for `smb-storage.testLocation`:

1. **Validation errors name the FIELD, never the VALUE.** The SFTP provider gets
   this right (`'config.host is required'`, `sftp-provider.ts:214`). Copy that
   shape. Never interpolate `cfg.password`, and never interpolate
   `cfg.username` either — a username is a credential half.
2. **Library errors are mapped, not forwarded.** SFTP forwards
   `err.message` verbatim (`sftp-provider.ts:234`). For SSH that is usually
   benign; for an NTLM handshake the library may put the account or domain in
   the message. Map to a closed set — `'authentication failed'`,
   `'share not found'`, `'connection refused'`, `'timed out'`,
   `'permission denied on basePath'` — and log the raw error at `warn` with
   `ctx.logger`, where it is not on an operator-facing wire.
3. **Never log the config object.** Not at `debug`, not in a "connection
   established" line. The SFTP provider logs only its pool key
   (`sftp-provider.ts:283`) — and that pool key must be built from
   `(host, port, username)` shape only, never including the password.

---

## 6. Wiring, and what ships how

### 6.1 Wiring for the SMB provider (Option B)

Per `add-addon`, four places, one silent. The `add-capability` skill does not
apply: **no `*.cap.ts` changes, therefore no `npm run codegen`.**

| # | Place | Change |
| --- | --- | --- |
| 1 | `packages/addon-remote-storage/package.json` → `camstack.addons[]` | a fourth entry: `id: "smb-storage"`, `execution.group: "remote-storage"`, `category: "system"`, `instanceMode: "unique"`, `capabilities: [{ name: "storage-provider" }]`, a **non-optional `description`**, `icon`, `color` |
| 2 | **`packages/addon-remote-storage/vite.config.ts` → `entries`** | `'smb.addon': 'src/smb.addon.ts'`. **This is the silent one** — a manifest `entry` is just a string, nothing resolves it at build time. |
| 3 | `packages/addon-remote-storage/src/index.ts` | re-export `SmbStorageAddon` and `SmbStorageProvider` |
| 4 | *(builtins only)* | n/a — this is a package addon |

Also required:

- `dependencies` in `package.json` for the SMB client, **plus** an entry in
  `camstack.runtimeDependencies` alongside `@aws-sdk/client-s3` / `webdav`, and
  `extraExternals` in `vite.config.ts` if the client is not already in
  `COMMON_NATIVE_DEPS`.
- **A distinct `addonId`.** `smb-storage`, not a second provider registered from
  `sftp-storage` — collection providers are keyed by `addonId` and a duplicate
  collapses to one (`packages/addon-remote-storage/src/index.ts:7`).
- Update the two comments that enumerate "three addon ids":
  `server/backend/src/core/addon/runner-spawn-fanout.ts:76` and
  `server/backend/src/core/addon/addon-registry.service.ts:3735`. Leaving them
  saying "three" is exactly the leftover-that-reads-as-verification the working
  style forbids. The spec at
  `server/backend/src/core/addon/__tests__/runner-spawn-fanout.spec.ts:104`
  names the three explicitly and will need the fourth.
- A new spec for the SMB provider, mirroring
  `packages/addon-remote-storage/src/providers/sftp/__tests__/sftp-provider.spec.ts`
  in the equivalent `smb` directory, plus an entry in
  `packages/addon-remote-storage/src/providers/__tests__/provider-info.spec.ts`.

**A D29 note.** `execution.group: "remote-storage"` co-locates all four
providers in **one runner**, so an SMB client crash respawns SFTP, S3 and WebDAV
with it. D29 confines RAM-reclaiming grouping to non-live, frame-free, low-crash
addons. Storage providers are frame-free and non-live; the group is
pre-existing and joining it is consistent. But an unmaintained 2023 SMB fork is
*not* obviously low-crash, and if it proves crashy the correct response is to
give `smb-storage` its own group — not to accept sibling respawns.

### 6.2 Verify

```bash
npx tsx scripts/check-addon-entries.ts
npm run typecheck && npm run test
npm run build -w packages/addon-remote-storage && ls packages/addon-remote-storage/dist/
npm run docs:check
```

The `ls` is not ceremony — it is the check that wiring point #2 landed.

### 6.3 Deploy vs publish train

Server is at **1.2.192**, system at **1.2.157**.

| Change | Ships how |
| --- | --- |
| Option A (host CIFS mount + `filesystem-storage` location) | **Neither.** An operator action. Available today. |
| The `smb-storage` provider — new manifest entry, vite entry, provider code, deps | **`camstack deploy packages/addon-remote-storage`.** `@camstack/addon-remote-storage` is a published npm package addon reaching a node through `<dataDir>/addons/`, not a framework package. No `@camstack/server` republish. |
| **Credential redaction in `listLocations`** (§5) | **Publish train.** It lives in `packages/system` (`storage-orchestrator`), possibly `packages/types` if the sentinel needs a schema. Framework packages travel inside the `@camstack/server` closure, so it is not live until a published `@camstack/server` containing it is installed — regardless of what is in the registry. |
| Comment/spec updates in `server/backend/**` | **Publish train** (same closure). |
| An orchestrator-level `(host, share, basePath)` uniqueness guard (§2) | **Publish train.** Deferred — §7. |
| Any `*.cap.ts` change | Not in this design. If one appears, it is a framework change *and* `npm run codegen`. |

So the first cut is **two** shipping units, and their order matters: the
redaction (train) must be live **before** the provider (deploy) starts collecting
SMB passwords. Shipping the deploy first because it is faster is how the
deployed-but-not-covered regression gets programmed in.

---

## 7. Staged plan

### Stage 0 — today, no code

Operator host-mounts the Unraid share **`soft`** and creates
`backups:unraid` on `filesystem-storage` pointing at the bind-mounted path.
Nightly backup fans out to it via the existing schedule. Nothing to build.

Exit criterion: an archive lands, `backup.listDestinations` shows a
`lastSuccessAt`, and `backup.restore` from it succeeds. **Restore must be tested,
not assumed** — a backup destination that has never been restored from is a
belief, not a backup.

### Stage 1 — credential redaction (framework, publish train)

Redact `type: 'password'` fields from `storage.listLocations` /
`getDefaultLocation`, driven by each provider's own `configSchema`. Sentinel
write-back on `upsertLocation`. Fixes SFTP/S3/WebDAV at the same time.

Exit criterion: a non-admin session calling `storage.listLocations` gets the
sentinel; the wizard can edit a location without retyping the password; a test
asserts the sentinel — and, per the working style, **removing the redaction must
make that test fail**.

### Stage 2 — the `smb-storage` provider (deploy)

> **The opening spike below is SUPERSEDED and was not run.** See the status
> note at the top: the client is `samba-client@^7.2.0` over the `smbclient`
> binary, which the operator already runs in production. What replaced the
> spike is the binary's absence from the container — solved by the manifest's
> `systemDependencies` (D297), not by a Dockerfile change.

Wiring per §6.1. Scope: the full `storage-provider` surface, modelled on
`sftp-provider.ts`, with:

- `nodeLocal: false`, `shouldSaveDiskSpace: false`, `minFreePercent: null`,
  `getAvailableSpace` → `null`.
- Session-pooled connection keyed by `(host, share, username)`, evicted on
  disconnect — the SFTP pool pattern (`sftp-provider.ts:265`).
- `.partial` → unlink → rename finalize.
- **Verify-on-finalize** (§3): stat the target, compare to `bytesWritten`,
  throw on mismatch.
- **Short, explicit timeouts on every operation.** SMB stalls; the 5-minute idle
  abort is a backstop, not a timeout.
- `testLocation` per §5's three rules, including the duplicate-share check.
- Every dropped-work branch logs (a disconnect mid-upload, an aborted session, a
  refused duplicate). Silence reads as "never happened".

Exit criterion: a nightly archive lands on the Unraid share through the
provider, retention deletes the overflow, and **a restore from it succeeds**.
Plus: pull the network cable mid-upload and confirm the destination reports its
*previous* archive as newest, no partial file is listed, and the next run
succeeds.

### Stage 3 — what would have to be true before anything else moves onto SMB

Not a plan. A list of preconditions, each of which is its own piece of work:

1. **`storage.resolve` + raw `fs` must stop being the media contract** (§0.3).
   Until `recordings` / `eventMedia` / `galleryMedia` do their I/O through the
   cap — or until a provider can present a local path it genuinely owns — no
   remote provider serves them, SMB included. This is the single largest item
   and it is a recorder/post-analysis change, not a storage change.
2. **`physicalRootKey` must refuse a non-local root** (§4) rather than returning
   a lexical string that can merge two different servers. It should return
   `null`/a provider-qualified key, and callers must handle it.
3. **A staging-and-verify writer for segment media**, so D291's copy → verify →
   repoint → delete ordering holds over a transport whose `close` is not a
   durability statement.
4. **A checksum in the backup manifest**, if `backups` is to be trusted beyond
   "the right number of bytes arrived". `backup` cap change.
5. **A mid-write disconnect faced deliberately**, under load, with the result
   written down. Until that exists, "SMB holds recordings" is a claim nobody has
   tested.

---

## 8. What could not be determined

- **SUPERSEDED — whether any maintained Node SMB client exists.** The question
  was the wrong one. `smbclient` is maintained by the Samba project, and
  `samba-client@^7.2.0` wraps it. Original text follows.
- Every candidate found on
  npm is a fork of the abandoned `@marsaud/smb2` (2022-06-12):
  `v9u-smb2@1.0.6` (2022-08-22), `@tryjsky/v9u-smb2@1.1.0` (2023-06-30),
  `smb2@0.2.11` (2022-06-26). None verified against Node 24. **Stage 2 should
  begin with a spike that proves a chosen client can connect, write 1 GB,
  survive a disconnect, and stat a file — before any provider code is written.**
- **SUPERSEDED — whether that client exposes
  `FSCTL_QUERY_FS_FULL_SIZE_INFO`.** Not applicable to the binary route.
  `getAvailableSpace` returns `null` and the provider declares
  `shouldSaveDiskSpace: false`: a provider that promises a threshold it cannot
  measure is worse than one that admits it cannot.
- **Whether the Unraid share is SMB3-capable and what its minimum dialect /
  signing / encryption settings are.** Not inspected — the production hub is
  under a drain and out of bounds for this investigation.
- **Whether the hub container can see a host CIFS mount without a compose
  change.** `docker-compose.yml:62` maps `./camstack-data:/data` and grants no
  `cap_add`; a host mountpoint would need its own bind entry. Not tested.
- **Whether `provider-settings` or any other read surface also returns storage
  `config`.** Only `storage.listLocations` and `getDefaultLocation` were traced.
- **Whether an `smb-storage` addition trips any generated-doc guard beyond the
  addons/packages tables.** `npm run docs:check` is stale on this tree for
  unrelated reasons (§9), so its output could not be used as a clean signal.

---

## 9. Falsifiers — what would make this design wrong

1. **A maintained, Node-24-tested SMB client exists that I did not find.** Then
   Option B's dependency objection collapses, and Option B becomes the default
   rather than the earn-its-way-in path. *Check: search npm and GitHub for
   SMB3-capable Node clients published after 2024.*
2. **Something other than `backup-orchestrator` writes to `backups` locations.**
   The claim "a backup destination IS a `backups` storage location" rests on
   `listLocations({ type: 'backups' })` being the only enumeration. *Check:
   `grep` for `'backups'` across every addon; if a second writer exists, the
   single-writer argument in §2 fails and the duplicate-share hazard gets worse.*
3. **A consumer routes `backups` I/O through `storage.resolve` + raw `fs`, the
   way the recorder does for `recordings`.** Then §0.3's boundary is wrong and
   `backups` on a remote provider is broken today — meaning SFTP/S3/WebDAV
   backups have never worked and nobody noticed. *Check:
   `grep -rn "storage.resolve" | grep -i backup`. Nothing was found, but a
   restore path was not traced end to end.*
4. **`docker-compose.yml`'s hub can already see a CIFS mount, or already cannot
   be given one.** Either answer moves Stage 0. *Check: try it on a
   non-production host.*
5. **`type: 'password'` is not a reliable discriminator for "secret" in
   `ConfigUISchema`.** §5's redaction is schema-driven; if a provider carries a
   secret in a `text` field (an S3 secret key? a WebDAV token?), the redaction
   misses it and gives false assurance — which is worse than no redaction.
   *Check: audit every `configSchema` in `addon-remote-storage` for
   secret-bearing non-`password` fields before building the mechanism.*
6. **The operator wants the SMB share for `recordings`, not `backups`.** The
   entire staging here assumes backups first. If the real goal is footage on the
   NAS, Stage 3 item 1 is the project and this document is a preamble to it.
7. **`recordings` on an Option-A CIFS mount is deemed acceptable.** It is not
   addressed here beyond §4's statfs note, and the §3 objections (silent black
   windows, D291's trust in the durable row) apply to a hard-mounted CIFS
   filesystem just as much as to a userspace client — arguably more, because
   `statfs` succeeding makes the guards *look* healthy.

---

## 10. Related records

- [D291](../decisions/adr-0291-a-relocation-moves-the-durable-hour-row-or-it-has-not-happened.md)
  — copy → verify → repoint → delete; why a returned write is not trusted.
- [D293](../decisions/adr-0293-a-location-is-deleted-only-after-it-is-verified-empty-and-unreachable-is-not-empty.md)
  — unreachable is not empty; the refusal §1 leans on.
- [D295](../decisions/adr-0295-the-ledger-is-the-archive-the-ram-index-answers-only-about-what-is-resident.md)
  — the durable ledger is the authority a bad write corrupts.
- [D29](../decisions/adr-0029.md) — grouping addons into one runner.
- [D145](../decisions/adr-0145.md) — `covers:` vs `applies-to:`; why this
  document carries neither.
- [Non-blocking storage migration](2026-08-29-non-blocking-storage-migration.md)
  — the drain whose headroom guard §4 examines.
