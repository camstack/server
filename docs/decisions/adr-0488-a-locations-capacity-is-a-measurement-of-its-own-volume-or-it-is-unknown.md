---
id: D488
title: A location's capacity is a measurement of its OWN volume, or it is unknown
status: accepted
date: 2026-09-13
supersedes:
applies-to:
  - packages/system/src/builtins/storage-orchestrator/location-volume-capacity.ts
  - packages/system/src/builtins/storage-orchestrator/storage-orchestrator.addon.ts
  - packages/addon-admin-ui/src/components/storage/location-capacity-bar.ts
---

## Context

The Storage page showed two `backups` locations with byte-identical bars: "Kept
free 47.1 GB / Used 291 GB (62%) / Free 133 GB (28%)". One is
`filesystem-storage` at `/data/backups` on the hub; the other is `smb-storage`
on `//192.168.x.x/backups`. `storage.listLocations` on the live hub confirmed
it was not a rendering coincidence:

```
backups:default  filesystem-storage  total=506107977728  avail=193348673536  owned= 9.9 GB
backups:smb      smb-storage         total=506107977728  avail=193348673536  owned= 1.6 GB
```

`owned` is measured per location and differed correctly. `capacity` did not,
because the probe never looked at the provider. `localCapacityOf` took
`config.basePath`, `path.resolve`d it **against the hub process's cwd**, walked
up to the nearest existing ancestor when that path did not exist, and `statfs`'d
whatever it landed on. The SMB row's `basePath` is `"camstack"` — a path inside
the SMB share, relative by construction — so the walk climbed to the container
root and reported the HUB's own disk as the share's. The operator was told an
SMB share was 62% full by a reading nobody had taken of it.

The same figure also feeds `resolveMinFreePercent`, so a `minFreeGb` set on that
location would have been converted against the wrong disk's total; and the
pressure guard took its own second `statfs` of the raw `basePath`, which for a
location owned by ANOTHER node answers for whatever local path happens to carry
that name — a lie that decides eviction.

This is D296's shape in a third place. `access-guards.ts` already refuses
`storage.resolve` and local occupancy probes on a remote-backed location for
exactly this reason; a `statfs` is the same mistake with a number attached
instead of a path. It is also D393: the code had modelled "unknown" correctly all
the way to the screen — `capacity` is nullable, and `LocationCapacityBar` renders
`Capacity unknown` rather than an empty bar — and the probe simply never
produced an unknown, because its fallback always found *some* volume.

## Decision

**A location's capacity is a `statfs` that is genuinely ABOUT that location, or
it is `null`.** One module decides —
`storage-orchestrator/location-volume-capacity.ts` — and it requires all of:
the provider is KNOWN node-local (`getProviderInfo().nodeLocal === true`; an
unclassified provider is a guess, not a yes), the location belongs to this node,
and its `basePath` is ABSOLUTE. The ancestor walk stays, because a node-local
root that does not exist yet is normal and its parent is the volume a write
would land on today — but it stops at the filesystem root: reaching `/` means
every named segment is missing, which is what an unmounted array looks like, and
the root disk's size is not an answer about it. Every refusal carries a reason,
logged once per distinct fault per location, with one line when it recovers.
The pressure guard reads the SAME probe — one capacity truth per location — and
an unmeasurable volume degrades it to `100`% free and a `0` byte target, i.e.
inert, exactly as an unstattable path already did.

**Unknown is a missing denominator, not a missing numerator.** A row whose
volume cannot be measured still reports what CamStack HOLDS there when a
provider measured it (`UnknownCapacityBar.owned`) — the SMB share's 1.6 GB is a
fact we have.

## Consequences

- `backups:smb` (and every future S3/SFTP/WebDAV location) now reads
  `Capacity unknown · CamStack holds 1.6 GB` instead of a confident bar. That is
  the honest state until a provider can answer "how big is the remote volume" —
  which no storage-provider method currently asks. Adding that is the only way
  to get a real bar there; inventing one from a local path is not.
- A location whose node has not yet classified its provider (the boot window
  before the first `getProviderInfo` sweep) reports unknown and logs why, then
  logs the recovery. Self-healing, and visible.
- A node-local location whose mount is GONE now reads unknown instead of
  reporting the root filesystem's size. The `minFreeGb` conversion falls back to
  the percentage guard, which `location-protection.ts` already documents as the
  right direction, and the pressure guard goes inert on that location rather
  than evicting against another disk's numbers.
- The reason is logged, not carried on the wire. `StorageLocation.capacity`
  stays `{total, available} | null`; a `capacityUnknownReason` field would touch
  the cap schema, the generated types and every consumer to improve one tooltip.
  Revisit when a second consumer needs it.

## Enforcement

`packages/system/src/builtins/storage-orchestrator/__tests__/location-volume-capacity.spec.ts`
— the live `backups:smb` row is `unknown` and the reason names its provider; an
unclassified provider is `unknown`; a relative `basePath` is `unknown` even on a
node-local provider; a walk that reaches `/` is `unknown`; a node-local path is
measured, including via its nearest existing ancestor. All verified failing
against a verbatim port of the old `localCapacityOf`, which reported the hub's
root volume for the SMB row.
`packages/addon-admin-ui/src/components/storage/__tests__/location-capacity-bar.spec.ts`
pins the surviving `owned` figure. No guard script: "did this `statfs` describe
the thing it was asked about" is not greppable — the module is the guard, and it
is the only caller of `fs.statfs` in the orchestrator.

Related: [D296](adr-0296-a-path-nobody-can-resolve-is-confirmed-gone-per-path-and-a-path-that-resolves-is-repointed.md),
[D393](adr-0393-a-measurement-that-failed-is-not-a-measurement-of-zero.md),
[D315](adr-0315-not-yet-known-never-looks-like-not-installed-and-a-presence-gate-asks-the-registry.md),
[D388](adr-0388-occupancy-is-its-own-question-and-absence-is-an-answer.md).
