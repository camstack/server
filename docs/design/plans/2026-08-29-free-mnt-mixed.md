---
title: Freeing /mnt/mixed for CamStack — inventory, destination, and the order of operations
---

# Freeing `/mnt/mixed`

> **The operator's goal, 2026-08-29.** *Free the Unraid disk `/mnt/mixed` so it
> can be given entirely to CamStack, by moving the shares that live there onto
> the `common_backups` disk.*
>
> **Position, up front.** The goal is right and reachable. The route named in
> the request is not, and the inspection changed three things about its premise:
>
> 1. **`/mnt/mixed` is not a spinning disk. It is a Samsung SSD 870 QVO 2 TB
>    SATA SSD** (`ROTA=0`), and that is *why* the CamStack settings database
>    lives on it. `common_backups` is a Seagate ST2000LM007 — a 5400 rpm 2.5"
>    USB drive, the same class as the recordings spindle. For two of the five
>    items on the disk this is not a relocation, it is a demotion.
> 2. **It does not fit.** 605.6 GiB to place, **456.2 GiB free** on the
>    destination. The shortfall is 149 GiB before any headroom.
> 3. **The disk is already 65 % empty — 1.19 TiB free right now.** Whatever
>    CamStack wants the space for, it can have most of it today, with a bind
>    mount and a container recreate, without one byte moving.
>
> And the free space the destination is missing is already there: **1,102 GiB
> held by 40 `-failed` appdata-backup runs** the retention policy never pruned.
> That single decision — which is the operator's, not this document's — turns a
> plan that cannot execute into one that has 950 GiB of slack.

---

## 0 · Method, and what was deliberately not done

Everything below was read from the host on 2026-08-29 over `ssh unraid`,
**read-only**. No file was moved, deleted or renamed; no container was started,
stopped or recreated; no share or pool configuration was written.

Constraints honoured, and why they are named here rather than assumed:

- **No `du` on `/mnt/user`.** Every size below comes from `du -x --max-depth=1`
  bounded to a single physical mount, or from `df -B1`. The host even carries a
  user script called `Kill du -sb`, so this is a failure mode with history.
- **The production SQLite was never opened.** Its size comes from `ls -l` and
  `stat` only. `lsof` was used to learn *who holds it open*, which touches no
  page of the file.
- **The `previous-nvr` container was not touched.** It was read with
  `docker inspect` (which changes nothing) and appears in this plan only as a
  window the operator opens. Note for the record: at inspection time it was
  **running** (`Up 6 minutes`), not stopped as the briefing assumed.
- One read-only measurement **hung**: see §9.

---

## 1 · What `/mnt/mixed` actually is

| | `/mnt/mixed` | `/mnt/common_backups` | `/mnt/disks/recordings-2` |
| --- | --- | --- | --- |
| device | `/dev/sdb1` | `/dev/sdk1` | `/dev/sdm1` |
| model | **Samsung SSD 870 QVO 2 TB** | ST2000LM007-1R8174 | TOSHIBA MQ04UBD200 |
| `ROTA` / transport | **0** / SATA | 1 / USB | 1 / USB |
| rotation | *solid state* | 5400 rpm, 2.5" | 5400 rpm, 2.5" |
| filesystem | **xfs**, single device | btrfs (`single` data, `DUP` meta) | btrfs |
| size / used / free | 1.818 TiB / 641.7 GiB / **1.192 TiB** | 1.819 TiB / 1.373 TiB / **456.2 GiB** | 1.9 T / 1.2 T (65 %) |
| power-on hours | 18 261 | 18 014 | — |
| Unraid role | **pool** (`/boot/config/pools/mixed.cfg`) | **pool** | unassigned device |

Two structural facts follow from that last row and drive the whole procedure.

**`mixed` and `common_backups` are Unraid *pools*, not unassigned devices.**
Their contents are therefore also **shares**, reachable at `/mnt/user/<share>`
through `shfs`. Each share declares which pool holds it, e.g. `shareUseCache="only"`
with `shareCachePool="mixed"`. That means there are two entirely different kinds
of consumer on this disk, and they behave oppositely under a move:

- A consumer that reads through **`/mnt/user/...`** survives a pool change
  transparently. `shfs` unions the pools; the path never changes.
- A consumer that binds the **pool path directly** (`/mnt/mixed/...`) breaks
  the instant the data is no longer there — silently, with I/O errors and no
  log line saying why. **Every such consumer is a container-recreate window.**

**Unraid's mover does not move pool → pool.** It moves array ↔ pool. Changing
`shareCachePool` from `mixed` to `common_backups` on a `shareUseCache="only"`
share **strands the existing data on the old pool** and only redirects *new*
writes. This has already happened once on this host: `camstack.cfg` says
`shareCachePool="common_backups"`, `/mnt/common_backups/camstack` exists and is
empty since 2026-08-17, and 1.05 GiB of live database sits on `mixed`. There is
even a `camstack.cfg.bak-pre-cache-drain-1785689252` recording the attempt. The
config and the truth disagree, and the config is the one nobody reads.

Consequence: **the move is `rsync`, not mover.** The share config change is the
last step of each item, not the first.

---

## 2 · The inventory

Depth-1, bounded to the mount (`du -x --max-depth=1 -B1 /mnt/mixed`):

| top-level | size | files | share cfg | who writes it, and through which mount | temperature |
| --- | ---: | ---: | --- | --- | --- |
| `ftp` | **437.3 GiB** | 69 992 | `ftp.cfg` → pool `mixed` | **`pure-ftpd`** via `/mnt/user/ftp` → `/home` (Reolink cameras push here). **`previous-nvr`** via the *direct* bind `/mnt/mixed/ftp/reolink` → `/Volumes/ftp` | **warm** — 10.4 GiB / 1 424 files in 7 d; newest file today 12:55 |
| `previous-nvr` | **166.8 GiB** | 668 365 | `previous-nvr.cfg` → pool `mixed` | **`previous-nvr`** only, via the *direct* bind `/mnt/mixed/previous-nvr` → `/Volumes/previous-nvr`. All of it is `advanced-notifier/<deviceId>/` | **hot, and small-file hot** — 73.4 GiB / **342 353 files** in 7 d (≈ 49 k files/day) |
| `camstack` | **1.05 GiB** | 6 | `camstack.cfg` → pool `common_backups` (**stale, see §1**) | **`CamStack`** via the *direct* bind `/mnt/mixed/camstack/addons-data/sqlite-settings` → `/data/addons-data/sqlite-settings` | **hot, and the only one that is a database** |
| `logs` | 348.5 MiB | ~30 | `logs.cfg` → pool `mixed` | host **`rsyslogd`** (`server_folder="/mnt/user/logs"`), plus `pihole-v6-unbound`, `Npm-Tailscale`, `GrafanaPromtail` — all via `/mnt/user/logs/...` | warm, but trivial in size |
| `zentik` | 4 KiB | 0 | *no share cfg exists* | nothing. Three nested empty dirs, untouched since 2025-10-13 | cold / orphan |
| `models` | 0 | 0 | `models.cfg` → pool `mixed` | nothing. Empty since 2025-07-21 | cold / orphan |
| **total (du)** | **605.6 GiB** | 738 821 | | | |
| **total (df used)** | **641.7 GiB** | | | | |

The 36.1 GiB `df − du` gap is xfs allocation overhead — 28 allocation groups,
`rmapbt` and `reflink` enabled, 739 k inodes — plus speculative preallocation.
There are no deleted-but-open files on the mount (`lsof +L1` is empty). **Budget
against the `df` number, 641.7 GiB, not the `du` number**; xfs will not hand back
what btrfs must then allocate differently.

### The three items that matter, in one line each

- **`previous-nvr/advanced-notifier`** is not 167 GiB of files, it is **668 365
  files** and it grows by ~49 000 of them a day. That is a metadata workload.
- **`ftp/reolink`** is a 13-month camera archive (oldest file 2025-07-19,
  newest today) split `dispensa` 384 G / `hub` 55 G, growing at ~1.5 GiB/day
  across ~200 files/day. Cold in the tail, warm at the head.
- **`camstack/addons-data/sqlite-settings`** is `camstack.db`, **1 121 865 728 B**,
  plus a live `-wal` (5.1 MB) and `-shm`. `lsof` shows exactly **one** holder:
  PID 404351 inside the `CamStack` container, with the file open `rw` and
  memory-mapped. There is no second writer, and no reader that would tolerate
  the bytes changing underneath it.

---

## 3 · Answering §10 of the recorder-index design — for free

`docs/design/2026-08-29-recorder-index-at-scale.md:492` lists as undetermined:

> *Where the settings-store SQLite physically lives (hub data dir vs the
> recordings array). Determines T2 cold-miss latency; must be checked before
> stage 3.*

**Determined. It does not share the media array, and it is the fastest device
in this machine after the NVMe.**

- Physical path `/mnt/mixed/camstack/addons-data/sqlite-settings/camstack.db`,
  on `/dev/sdb1` — Samsung 870 QVO SATA SSD, **xfs, single device, no COW**.
- It reaches the container through a dedicated bind, *not* through `/data`
  (which is `/mnt/cache/appdata/camstack`) and *not* through `/recordings`
  (which is the USB spindle). It never passes through `shfs`.
- The Unraid template records the reasoning and the measurement in its own
  description field: *"Database SQLite sul pool mixed (xfs, SSD, niente COW):
  misurato 5.7 ms per fsync contro 8.5 ms sul cache btrfs RAID1. Mai
  `/mnt/user`, passa da shfs."* The same numbers are in
  (planning repo: sessions/2026-08.md:11605). <!-- drift-ok: moved to the private planning repo -->

So the gate on stage 3 of that design is **cleared**: a T3 point-read against
the settings DB is a SATA-SSD random read, not an array readdir. The
`~ms instead of ~650 ms` estimate at
`docs/design/2026-08-29-recorder-index-at-scale.md:434` holds on today's layout.

**It stops holding the moment this migration moves the DB.** That is the next
section.

---

## 4 · The destination, measured

### 4.1 It does not fit

```
/mnt/common_backups   size 2 000 398 897 152 B   used 1 509 786 894 336 B   avail 489 860 382 720 B
```

456.2 GiB free against 605.6 GiB (du) / 641.7 GiB (df) to place. btrfs confirms
it independently: `Device unallocated: 438.95 GiB`, `Data,single 1.39 TiB used
1.37 TiB (98.78 %)`. And btrfs at ~100 % of allocated data chunks is where this
filesystem starts behaving badly, so the practical ceiling is lower than the
number.

### 4.2 …but 1 102 GiB of it is garbage the retention policy never collected

The Appdata Backup plugin is configured `deleteBackupsOlderThan: 10`,
`keepMinBackups: 10`, destination `/mnt/user/backups/unraid/`, daily at 04:15.
There are nevertheless **40 directories named `ab_*-failed`**, totalling
**1 102.4 GiB**, going back to 2026-08-02 — 25–42 GiB each, across both
`backups/unraid` and `backups/agent-a`. The plugin prunes its successful
runs and leaves the failed ones forever.

That is **79 % of everything on the destination disk**. Reclaiming it is one
command and it is the difference between a plan that cannot start and a plan
with 950 GiB of slack. It is also **not this document's decision** — a
`-failed` run means one container's archive errored, not that the other forty
containers in the same run are unreadable. See §8.

### 4.3 The destination is an active backup target, and that couples two failure domains

Backups landed there today at 05:35, 05:43, 05:44, 06:31, 09:10 and 10:01 —
appdata (this host), appdata (`agent-a`), Home Assistant, Immich, the
CCU3, and a reference NVR backup every two hours. So:

- **Free space is not static.** ~27 GiB/night for the appdata run alone.
- **There is a nightly 04:00–07:00 I/O window** during which any migration
  `rsync` and the backup job fight over one 5400 rpm spindle.
- Putting production data on the backup disk means **a full backup disk becomes
  a production outage**, and a production disk failure takes the backups with
  it. Today those are two devices; after this migration they are one.

### 4.4 The class problem — and the measurement that already exists

`common_backups` is not the recordings disk, but it is the same *class*. What
was measured:

- **Sequential read is fine**: 400 MiB `O_DIRECT` off an existing file returned
  **108 MB/s**. Bulk copying *onto* it is not the problem.
- **Concurrent small I/O is not.** The sibling `sdm` was sampled during this
  investigation at **97.82 % util for 16.30 MB/s of writes** — 88.6 w/s,
  `w_await` 14.43 ms, queue 1.76. In the same sample `sdb` (the SSD being
  vacated) sat at **2.00 % util** for 3.26 MB/s with `w_await` 3.39 ms.
- **This exact move was already measured and rejected, on this exact disk.**
  From the 2026-08-25 session (planning repo: sessions/2026-08.md:11605): <!-- drift-ok: moved to the private planning repo -->
  *"5,7 ms/fsync su xfs contro 8,5 su cache e **68,9 sul disco di backup**, che
  era la destinazione proposta e sarebbe stata 8× peggio."* [5.7 ms/fsync on xfs against 8.5 on cache and **68.9 on the backup disk**, which was the proposed destination and would have been 8× worse.] The backup disk was
  **12× slower than where the database is now**, and it was excluded *with a
  measurement*, not an opinion. `docs/roadmap.md:85` records the same verdict. <!-- drift-ok: moved to the private planning repo -->
- ST2000LM007 is, per Seagate's own 2020 SMR disclosure, a **drive-managed
  shingled** model. No host command reports that (see §9), but it is consistent
  with the 68.9 ms figure and it is the mechanism by which a 668 k-small-file
  workload degrades over time rather than immediately.

**Conclusion for the table in §5:** `common_backups` is an acceptable
destination for *cold bulk*. It is the wrong destination for the settings
database (measured, 12×) and a poor one for 49 000 small file creations a day.

### 4.5 There is a better destination for the bulk, and it is already there

The parity-protected array has **8.6 TiB free** (`disk3` alone has 5.2 TiB).
For a 13-month FTP archive that is read rarely and written 200 files/day, the
array is strictly better than the backup disk: more room, parity protection,
and it does not couple production to backups. It costs nothing extra in the
procedure — an Unraid share can target the array by setting
`shareUseCache="no"` instead of naming a pool.

---

## 5 · Move, do not move, decide with the operator

| item | size | verdict | why |
| --- | ---: | --- | --- |
| `models` | 0 | **move (or delete)** — trivial | Empty since 2025-07-21. Nothing mounts it. |
| `zentik` | 4 KiB | **decide** | Three nested dirs, one empty `icon/` folder, untouched since 2025-10-13. No `zentik.cfg` share exists — this is an orphan the share list does not know about. `zentik-notifier` mounts `/mnt/user/appdata/zentik-notifier/attachments`, a *different* path. Almost certainly dead; only the operator knows if it is. |
| `logs` | 348 MiB | **move** — to `common_backups` | Cold in size, warm in access. Cheap, and it is the right first rehearsal of the whole procedure. Carries one hidden dependency: see §7.2. |
| `ftp` | 437.3 GiB | **move — but to the ARRAY, not to `common_backups`** | Alone it consumes 96 % of the destination's free space and leaves nothing for anything else. On the array it fits with 4.8 TiB to spare and gains parity. Requires a `previous-nvr` window (§7.3). |
| `previous-nvr` | 166.8 GiB | **decide — do not default it to `common_backups`** | 668 k files, +49 k/day. This is the one workload on the disk that a USB SMR drive is worst at. Three real options in §8. |
| `camstack` (the settings DB) | 1.05 GiB | **DO NOT MOVE** | Measured 68.9 ms/fsync on this destination vs 5.7 ms today — 12× worse, already rejected once on this host. It is also 0.16 % of the disk, and the disk is being freed *for CamStack*: moving CamStack's own database off it to make room for CamStack is self-defeating. It stays. |

**Net effect if the recommendation is taken:** `common_backups` receives 348 MiB
(`logs`) and nothing else; the array receives 437 GiB (`ftp`); `previous-nvr`'s
167 GiB is decided separately; `camstack` stays. `/mnt/mixed` ends at
**1.05 GiB used, 1.81 TiB free** — which is the stated goal.

### The question that should be asked before any of it

**`/mnt/mixed` already has 1.192 TiB free.** The purpose of freeing it is on
record: `docs/design/2026-08-25-scrub-advanced-analysis.md:113` proposes it as
the `recordingsLow` target at *"~1 month of low"*, sized at ≈ 36 GB/day for the
whole fleet. Against today's free space that is **already ~33 days**. Moving
everything buys 605 GiB → **+17 days**, at the cost of relocating 738 k files
onto a disk that cannot hold them.

So the honest framing of the decision is: *is 50 days of low-tier retention
worth this migration, when 33 days is available this afternoon for the price of
one bind mount and one container recreate?* That is a real question with a
possible "yes" — but it should be asked before the disk is emptied, not after.

---

## 6 · The Docker bind-mount trap — as a rule, not a footnote

Today `/recordings` inside `CamStack` kept pointing at a device that had been
unmounted and remounted underneath it. The container saw a dead directory,
every recording write failed, and the only symptom was I/O errors. **A bind
mount is resolved once, at container start.**

Two distinct cases, and they need different remedies:

| what changed on the host | what the container needs | why |
| --- | --- | --- |
| the host **mount** under an unchanged bind *source path* went away and came back | **`docker restart <name>`** | The bind is re-resolved from `HostConfig` at start. Restart is sufficient *and required*. |
| the bind **source path itself** changes (`/mnt/mixed/x` → `/mnt/user/x`) | **recreate** — Unraid → Docker → Edit → change the path → Apply | `HostConfig` is immutable on a live container. `docker restart` will faithfully re-bind the *old* path. |

**Rule for this plan: every step that changes a host mount or a host path under
a running container names the restart or the recreate as part of that step.**
Not as a follow-up, not as a verification item. A step whose last line is not
"…and the container is back up and writing" is not finished.

The three direct-bind consumers on this disk, all of which fall into the second
row above if their data moves:

```
CamStack   /mnt/mixed/camstack/addons-data/sqlite-settings -> /data/addons-data/sqlite-settings
previous-nvr   /mnt/mixed/previous-nvr                             -> /Volumes/previous-nvr
previous-nvr   /mnt/mixed/ftp/reolink                          -> /Volumes/ftp
```

Everything else on this disk goes through `/mnt/user` and survives a pool
change without a recreate — though §7.2 explains why `logs` still gets a
restart.

---

## 7 · The procedure

Ordered cheapest-and-most-reversible first. **Every command below is written in
the exact form it would be run. None of them has been run.** Steps are
independent: stopping after any one of them leaves a consistent system.

Prerequisite for all of them, and it is not optional:

### 7.0 · Back up the settings database — because nothing does

`CamStack` is `"skip": "yes"` in the Appdata Backup plugin, and
`backupExtVolumes` is `"no"` for **every** container on this host (0 matches).
`allowedSources` is `/mnt/user/appdata` + `/mnt/cache/appdata`. The settings DB
is on neither. `/mnt/common_backups/backups/camstack/` contains one 36-byte
`manifests.json` from 2026-05-09.

**`camstack.db` has no backup.** Before any step that touches this disk:

```bash
docker stop CamStack
mkdir -p /mnt/cache/appdata/camstack-db-backup-20260829
cp -av /mnt/mixed/camstack/addons-data/sqlite-settings/. \
       /mnt/cache/appdata/camstack-db-backup-20260829/
ls -l /mnt/cache/appdata/camstack-db-backup-20260829/
docker start CamStack
```

Container-stop window: **~30 s**, `CamStack` only.

Why stopped and why `cp`: the file is open `rw` and mmap'd by PID 404351 with a
live WAL. A copy taken while that process runs copies a torn database. **Do not
substitute `sqlite3 .backup`, not even `mode=ro`** — doing that against this
database via `/mnt/user` corrupted production on 2026-08-19. A cold `cp` of the
whole directory (db + `-wal` + `-shm`) with the writer stopped is the safe form,
and it is the *only* form used anywhere in this plan.

Rollback: none needed; it creates a copy and changes nothing else.

---

### 7.1 · Reclaim the destination (operator decision — see §8.1)

Nothing else fits until this happens. **List first, delete second, as two
separate commands**, so the operator sees exactly what goes:

```bash
find /mnt/common_backups/backups/unraid /mnt/common_backups/backups/agent-a \
  -mindepth 1 -maxdepth 1 -type d -name 'ab_*-failed' -printf '%p\n' | sort
```

Expected: 40 directories. Then, and only after the operator has read that list:

```bash
find /mnt/common_backups/backups/unraid /mnt/common_backups/backups/agent-a \
  -mindepth 1 -maxdepth 1 -type d -name 'ab_*-failed' -exec rm -rf {} +
df -h /mnt/common_backups
```

Expected after: ~1 558 GiB free.

No container window. **Rollback: none — this is the one irreversible step in
the plan.** That is precisely why it is gated on §8.1 and why the listing is a
separate command.

---

### 7.2 · `logs` → `common_backups` (the rehearsal)

348 MiB, four writers, one hidden dependency. Do this one first even though it
saves nothing: it exercises the exact sequence the large moves use, at a scale
where a mistake costs minutes.

The hidden dependency: the user script **`Clear logs folder`** hardcodes
`LOG_DIR="/mnt/mixed/logs"`. After the move it will print *"Errore: directory
/mnt/mixed/logs non trovata"* and exit 1 — loudly, which is lucky. It must be
edited in this step, not later.

```bash
# 1 — stop the writers
/etc/rc.d/rc.rsyslogd stop
docker stop pihole-v6-unbound Npm-Tailscale GrafanaPromtail

# 2 — copy
mkdir -p /mnt/common_backups/logs
rsync -aHAX --numeric-ids --info=progress2 /mnt/mixed/logs/ /mnt/common_backups/logs/

# 3 — verify: this second pass must report nothing to transfer
rsync -aHAXn --numeric-ids --itemize-changes /mnt/mixed/logs/ /mnt/common_backups/logs/
du -x --max-depth=0 -B1 /mnt/mixed/logs /mnt/common_backups/logs
```

**4 — repoint the share.** Unraid GUI → Shares → `logs` → Primary storage →
`common_backups` → Apply. (Equivalent on disk: `shareCachePool="mixed"` →
`shareCachePool="common_backups"` in `/boot/config/shares/logs.cfg`. Prefer the
GUI; it reloads `shfs`, editing the file alone does not.)

**5 — edit the user script** (Settings → User Scripts → `Clear logs folder`):
`LOG_DIR="/mnt/mixed/logs"` → `LOG_DIR="/mnt/user/logs"`. Use the `/mnt/user`
form, not the new pool path — then it never needs editing again.

```bash
# 6 — remove the source only after 3 and 4 are green
rm -rf /mnt/mixed/logs

# 7 — restart the writers (part of this step, not a follow-up)
/etc/rc.d/rc.rsyslogd start
docker start pihole-v6-unbound Npm-Tailscale GrafanaPromtail

# 8 — confirm the pipe is live again
ls -l --time-style=full-iso /mnt/user/logs/ | head
```

Container-stop window: **3 containers + host `rsyslogd`, ~2 min.**

Why restart containers that mount `/mnt/user/logs/...` and therefore "should"
survive? Because their bind resolved through `shfs` to a dentry backed by the
`mixed` copy, and step 6 removes that copy. The path is stable; the inode
behind it is not. This is the `/recordings` failure in miniature, and a restart
costs seconds. **Restart them.**

Rollback: source is untouched until step 6. Before step 6 — revert the share to
`mixed` in the GUI, restart the writers, delete `/mnt/common_backups/logs`.
After step 6 — the data is on `common_backups` and the rollback is the same
procedure in reverse; nothing is lost.

---

### 7.3 · `ftp` → the array (437.3 GiB, and a `previous-nvr` window)

**Destination: the parity array, not `common_backups`** (§4.5). Requires a
`previous-nvr` recreate because of its direct bind.

The copy runs while everything is up — the source is append-only from the
camera side, at ~200 files/day, so a first pass under load followed by a short
catch-up pass under a stop is the right shape.

```bash
# 1 — bulk copy, everything running. Hours. Run it detached.
mkdir -p /mnt/user0/ftp
rsync -aHAX --numeric-ids --info=progress2 /mnt/mixed/ftp/ /mnt/user0/ftp/
```

`/mnt/user0` is the array-only view — writing there bypasses `shfs`'s pool
preference and puts the bytes on the array without touching the share config
yet. Allocation across `disk1..3` follows the array's own rules.

```bash
# 2 — how far off is it? (repeat until the delta is small)
rsync -aHAXn --numeric-ids --itemize-changes /mnt/mixed/ftp/ /mnt/user0/ftp/ | wc -l
```

**3 — WINDOW OPENS.** Stop the FTP receiver and the reader:

```bash
docker stop pure-ftpd
```

`previous-nvr`: **the operator stops it.** This plan does not issue a stop for that
container. Everything below assumes it is down.

```bash
# 4 — catch-up pass, nothing writing
rsync -aHAX --numeric-ids --delete --info=progress2 /mnt/mixed/ftp/ /mnt/user0/ftp/

# 5 — verify, both directions
rsync -aHAXn --numeric-ids --itemize-changes /mnt/mixed/ftp/ /mnt/user0/ftp/
find /mnt/mixed/ftp -xdev -type f | wc -l
find /mnt/user0/ftp -xdev -type f | wc -l
du -x --max-depth=0 -B1 /mnt/mixed/ftp
du --max-depth=0 -B1 /mnt/user0/ftp
```

File counts and byte totals must both match. Expected: 69 992 files (plus
whatever arrived during step 1).

**6 — repoint the share.** GUI → Shares → `ftp` → Primary storage → **Array**
(`shareUseCache="no"`), Apply.

**7 — recreate `previous-nvr` with the new bind.** Unraid → Docker → `previous-nvr` →
Edit → change `/mnt/mixed/ftp/reolink` to **`/mnt/user/ftp/reolink`** → Apply.
Apply recreates the container; that *is* the restart. Use the `/mnt/user` form
so this never has to be edited again if the share moves.

> The `previous-nvr` template also carries a second `mixed` bind
> (`/mnt/mixed/previous-nvr` → `/Volumes/previous-nvr`). If §7.4 is being done in the
> same maintenance window, change both in this one edit — one recreate instead
> of two.

```bash
# 8 — bring the receiver back
docker start pure-ftpd

# 9 — prove the whole chain works BEFORE deleting anything.
#     Leave this running for a camera upload cycle.
ls -lt --time-style=full-iso /mnt/user/ftp/reolink/hub/ | head -5
```

**WINDOW CLOSES** when `pure-ftpd` and `previous-nvr` are both up and a new file has
appeared at the new location.

```bash
# 10 — days later, once the operator is satisfied
rm -rf /mnt/mixed/ftp
```

Container windows: **`pure-ftpd` for the length of the catch-up pass; `previous-nvr`
recreated once** (operator-controlled).

Rollback at any point up to step 10: the source is intact. Revert the share to
`mixed`, revert the `previous-nvr` bind to `/mnt/mixed/ftp/reolink`, Apply, start
`pure-ftpd`. Steps 6–7 are the only ones that must be undone together — a share
pointing at the array with a container bound to the pool path is the split-brain
this whole document exists to avoid.

---

### 7.4 · `previous-nvr` — hold, pending §8.2

**Do not execute this step against `common_backups` without an explicit
decision.** 166.8 GiB is not the problem; 668 365 files and +49 000/day is. If
the operator chooses to move it anyway, the shape is identical to §7.3 with two
differences that must be planned for:

- **`previous-nvr` is stopped for the whole catch-up pass**, and with 668 k files
  even a delta pass is not seconds. Budget an hour, not a minute.
- **The bulk pass is the long one.** At the concurrent-write rate observed on
  the sibling USB disk (16.3 MB/s at 97.8 % util), 167 GiB of small files is a
  multi-hour to overnight copy that will collide with the 04:00–07:00 backup
  window. Schedule around it.

The commands, for completeness, with `<TARGET>` deliberately unbound until §8.2
answers it:

```bash
rsync -aHAX --numeric-ids --info=progress2 /mnt/mixed/previous-nvr/ <TARGET>/previous-nvr/
# … then: stop previous-nvr (operator) → delta pass → verify counts → repoint share
# → EDIT THE previous-nvr BIND /mnt/mixed/previous-nvr -> /mnt/user/previous-nvr → Apply (recreate)
# → verify a new event lands → only then rm -rf /mnt/mixed/previous-nvr
```

---

### 7.5 · The orphans

```bash
# inspect once more, then decide (see §8.3)
ls -laR /mnt/mixed/zentik
ls -la  /mnt/mixed/models
```

If the operator confirms both are dead:

```bash
rm -rf /mnt/mixed/zentik
rm -rf /mnt/mixed/models
```

`models.cfg` is a real share with no data and no consumer; deleting the
directory without deleting the share leaves Unraid free to recreate it on
`mixed`. Either delete the share in the GUI too, or repoint `models.cfg` to
another pool. Same reasoning applies to any share left declaring
`shareCachePool="mixed"`.

No container window. Rollback: none for `rm`; both are empty, so there is
nothing to roll back to.

---

### 7.6 · Make the configuration tell the truth, and stop the disk refilling

Two cleanups that cost nothing and prevent the next surprise:

**`camstack.cfg` says `common_backups`; the data is on `mixed`.** Since §5 keeps
the database where it is, the *config* is what is wrong. GUI → Shares →
`camstack` → Primary storage → `mixed` → Apply. Then the share config, the bind
mount and the bytes all agree for the first time since 2026-08-17.

**Audit what still points at the pool** — anything left here will silently
recreate a directory on the disk that is supposed to be empty:

```bash
grep -l 'shareCachePool="mixed"' /boot/config/shares/*.cfg
grep -rn '/mnt/mixed' /boot/config/plugins/user.scripts/scripts/ 2>/dev/null
for c in $(docker ps -a --format '{{.Names}}'); do
  docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{println}}{{end}}{{end}}' "$c" \
    | grep -q '^/mnt/mixed' && echo "$c"
done
```

At the end of the plan the expected answers are: `camstack.cfg` only; nothing;
`CamStack` only.

---

### 7.7 · Then, and only then — hand the disk to CamStack

Out of scope for this document, but it is the reason for all of the above, and
the sequencing trap is already written down. From
`docs/design/2026-08-26-low-events-storage-migration-to-ssd.md:112`: only
`sqlite-settings` is mounted into the container today, so a new location on
`mixed` needs a **new bind mount → container recreate**, and the host template
carries `CAMSTACK_JWT_SECRET` and `CAMSTACK_ADMIN_PASS` — **edit it, never
overwrite it with the repo copy.**

And the ordering error that document names explicitly: **do not make the new
storage location the default before the migration runs.** `plan()` derives the
source from the current default, so a pre-switched default makes source and
target identical and it throws — leaving the old data orphaned with nothing that
knows it is there. The default switch is already inside the migration's
`repointing` phase.

---

## 8 · What the operator must decide before anything starts

These are not research gaps. They are questions the filesystem cannot answer.

**8.1 — The 1 102 GiB of `-failed` backups.** Are those 40 runs restorable
material or debris? The plugin marks a whole run `-failed` when any single
container's archive errors, so a `-failed` run may still contain forty good
ones. Nothing else in this plan can proceed at scale until this is answered, and
it is the **only irreversible step**. A middle path exists: keep the newest two,
delete the other 38.

**8.2 — What happens to 167 GiB of the reference NVR Advanced Notifier data.** Three
options, and the operator's direction of travel decides:
- *Move to the array* — safe, parity-protected, ~4.8 TiB of room, no SMR
  concern. Recommended if the reference NVR stays in production.
- *Move to `common_backups`* — fits after 8.1, but puts 49 k file-creations/day
  on a 5400 rpm USB drive that is also the backup target. Not recommended.
- *Prune or drop it* — this is the reference NVR's event archive, and CamStack is
  replacing the reference NVR. If this data has already been superseded, the cheapest
  migration is not to migrate it. **Only the operator knows this.**

**8.3 — `zentik` and `models`.** Both look dead — `models` is an empty share
since 2025-07-21; `zentik` is three nested empty directories since 2025-10-13
with no share config at all and a `zentik-notifier` container that mounts a
different path entirely. Everything points at "delete", and nothing on the
filesystem proves it. Confirm before removing.

**8.4 — Does this migration need to happen at all?** §5 closing paragraph:
1.192 TiB is already free, which is ~33 days of `recordingsLow` at the measured
36 GB/day. The whole migration buys +17 days. If the answer is "yes, I want the
full disk", proceed. If it is "I wanted low-tier footage on the SSD", that can
be had this afternoon and the migration can be scheduled calmly, or skipped.

**8.5 — Should `common_backups` hold production data at all?** After this plan
it holds backups of six systems *and* live shares, on one 5400 rpm USB disk
with no redundancy. That is a deliberate reduction in fault isolation. It may be
the right trade for 348 MiB of logs. It is a bad one for anything larger.

---

## 9 · What could not be determined

- **Whether `common_backups` is specifically the "disco di backup" measured at
  68.9 ms/fsync on 2026-08-25.** The inference is strong — it is the only
  backup-role disk on this host, and the same serial (`ST2000LM007-1R8174_ZDZ3FK65`)
  appears in `unassigned.devices.cfg` under the mountpoint
  `/mnt/disks/unraid-backups` before it became a pool. Not proven from the
  session record itself, which names the disk by role, not by device. If the
  operator wants it re-measured before trusting §5, that is a **write** and so
  is not in this plan — it would need a small `fsync`-loop benchmark against a
  scratch file on the destination, run once, and it must not be run against
  `camstack.db`.
- **The device-managed-SMR property of ST2000LM007.** Taken from Seagate's
  vendor disclosure. No host-side command reports it: `smartctl` shows
  512e/4096p, 5400 rpm, 2.5", and Linux does not expose a zoned model for
  drive-managed SMR behind a USB bridge. The 68.9 ms figure is consistent with
  it but does not prove it.
- **Sequential-read timing of `/dev/sdk` via `hdparm -t`.** The command
  **hung**: it entered uninterruptible `D` state and stayed there for over
  25 minutes with `iostat` showing **zero** I/O on the device. It could not be
  killed. Do not repeat it on this host. The 108 MB/s figure in §4.4 comes from
  a filesystem-level `dd … iflag=direct` instead, which completed normally —
  use that method.
- **Where the 36.1 GiB `df − du` gap on `/mnt/mixed` goes.** Attributed to xfs
  metadata and speculative preallocation (28 AGs, `rmapbt`, `reflink`,
  739 k inodes). Not decomposed. It matters only as a reminder to budget the
  `df` number.
- **Whether the `-failed` backup runs contain restorable data.** Not opened —
  reading 1.1 TiB to find out would itself be a multi-hour load on the
  destination. §8.1.
- **What `previous-nvr/advanced-notifier/<deviceId>/` retention policy exists, if
  any.** 668 k files growing 49 k/day with the oldest data from May 2025 looks
  unbounded, but that is the reference NVR's configuration and reading it means
  inspecting a container this plan is forbidden to touch.
- **Which shares still matter to the operator.** No amount of `find` answers
  this. It is why §5 has a "decide" column instead of a complete verdict, and
  why every `rm` in §7 is gated behind a listing command and a §8 question.
