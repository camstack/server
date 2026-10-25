/**
 * Connection tuning for the hub's SQLite database.
 *
 * Every number here is sized against a MEASURED database, not a blog post.
 * On the live hub (2026-08-06), 20 Hz syscall sampling of hub-main put **210
 * of 2,561 samples inside `pread64`** — 161 on `camstack.db` and 49 on
 * `camstack.db-wal`, all 4 KiB page reads, i.e. page-cache misses. That is
 * 8.2% of wall-clock and ~20% during bursts, on the single thread that also
 * serves every tRPC request. fds 79/81 of hub-main were the two files, so the
 * cost is proven in-process rather than inferred.
 *
 * The database was **130 MB** with a **249 MB** WAL high-water mark. Its
 * tenants are not settings: the analytics event/track/media stores and the
 * sqlite-vec index all live in this one file.
 */

/**
 * Page cache, in KiB (SQLite reads a NEGATIVE `cache_size` as KiB rather than
 * as a page count, which is what makes it independent of `page_size`).
 *
 * -65536 = **64 MiB**. Sized from the 130 MB file: the hot working set is the
 * B-tree interior pages plus the indexes the analytics queries walk, which is
 * a fraction of the total — 64 MiB covers roughly half the file outright, so a
 * repeated query stops re-reading the same 4 KiB pages from disk. Going to the
 * full 130 MB would buy the tail of a cold table scan for twice the resident
 * cost; going smaller leaves the measured miss rate roughly where it is.
 *
 * Why the build default is not enough: better-sqlite3 compiles with
 * `SQLITE_DEFAULT_CACHE_SIZE=-16000`, so the starting point is ~16 MiB — 8x
 * short of the file, not the ~2 MiB stock SQLite default. This is a 4x
 * increase, not a 32x one.
 *
 * Cost: 64 MiB of malloc'd C memory, ONE connection's worth (better-sqlite3
 * holds a single handle and the vector index shares it). It is off-heap, so it
 * does not move V8's heap ceiling — the thing that produced the hub's previous
 * OOM.
 */
export const SQLITE_PAGE_CACHE_FLOOR_KIB = -65_536

/**
 * Memory-mapped I/O window, in bytes. 268435456 = **256 MiB**.
 *
 * Chosen to exceed the 130 MB database with room for it to roughly double, so
 * the whole main file can be mapped. Pages then arrive as minor faults against
 * the OS page cache instead of `pread64` syscalls — which is precisely the
 * 161-sample half of the measurement. It also means a page evicted from
 * SQLite's own cache is usually still resident in the OS cache, so the two
 * knobs compound rather than duplicate.
 *
 * Two honest caveats:
 *  - SQLite **never mmaps the WAL**. The 49 WAL samples are not addressed
 *    here; they are addressed by keeping the WAL small (see
 *    {@link SQLITE_JOURNAL_SIZE_LIMIT_BYTES} and `wal-maintenance.ts`).
 *  - With mmap, an I/O error on a mapped page surfaces as SIGBUS rather than a
 *    catchable SQLite error. The pragma is asserted in
 *    `__tests__/sqlite-pragmas.spec.ts` by reading it back, so a build that
 *    ignores it (`SQLITE_MAX_MMAP_SIZE=0`) fails loudly instead of quietly
 *    doing nothing.
 */
export const SQLITE_MMAP_FLOOR_BYTES = 268_435_456

/**
 * Upper bound on the WAL file left on disk after a checkpoint resets it, in
 * bytes. 67108864 = **64 MiB**.
 *
 * This is the passive half of the WAL fix and it carries no stall risk at all:
 * it takes no lock and blocks nothing. It only says "when a checkpoint has
 * already succeeded, truncate the file rather than leaving the space
 * allocated". Without it, a WAL that spiked once stays spiked — which is how
 * a 130 MB database ends up with a 249 MB sidecar.
 *
 * 64 MiB is deliberately well above the ~4 MiB `wal_autocheckpoint` threshold
 * (1000 pages), so ordinary operation never touches this ceiling and the file
 * is not being repeatedly truncated and re-grown.
 */
export const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 67_108_864

/**
 * `synchronous` is deliberately NOT set here.
 *
 * better-sqlite3 compiles with `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`, so a WAL
 * database is **already** at `NORMAL`. Writing `PRAGMA synchronous = NORMAL`
 * would be a no-op that reads, forever after, like a durability decision
 * somebody made — the kind of leftover that is worse than nothing because it
 * looks like verification. `__tests__/sqlite-pragmas.spec.ts` asserts the
 * effective value instead, so a dependency bump that changes the default is
 * caught rather than assumed.
 *
 * **When it takes effect, measured (2026-08-08).** The WAL default is applied
 * when the WAL is actually opened — the first read/write transaction — NOT when
 * `PRAGMA journal_mode = WAL` runs. On a brand-new file the sequence reads:
 *
 *     after `journal_mode = WAL`, before any write   → 2 (FULL)
 *     after the first write                          → 1 (NORMAL)
 *
 * `initialize()` writes (`ensureTable`, `seedDefaults`) before anything can
 * observe the value, so production is at NORMAL on first boot and every boot
 * after. Recorded because reading the pragma immediately after setting the
 * journal mode reports FULL and looks exactly like a regression in this file.
 */
export const SQLITE_SYNCHRONOUS_IS_BUILD_DEFAULT = true

/**
 * This connection's `wal_autocheckpoint`, in pages. 10 000 = **ten times the
 * engine default**, ~40 MiB of WAL.
 *
 * The checkpoint is no longer this connection's job. Under `synchronous =
 * NORMAL` the fsyncs of a WAL database happen at the checkpoint and nowhere
 * else, and the engine's auto-checkpoint runs INSIDE the commit of whichever
 * writer crosses its threshold — so on the hub every 1000 frames (12–25 s) a
 * one-row `set` paid two fsyncs and a ~1000-page copy on the thread every
 * configuration read in the cluster queues behind, and paid 1–10 s for it
 * whenever the shared QLC drive was saturated (D449, measured in D452). The
 * checkpoint now runs on a worker thread over its own connection at the SAME
 * 1000-frame rule (`wal-checkpoint-policy.ts`), so the disk is asked for
 * the same number of syncs by a thread nobody waits on.
 *
 * Why not `0` (auto-checkpoint off): a worker that dies would leave the WAL
 * unbounded, and reads of a WAL page are `pread64`s the map never covers.
 * Ten times the default is a bound the worker never lets it reach — it is
 * the fallback, and `WalCheckpointer` logs an ERROR naming it the moment it
 * becomes the only checkpoint. `__tests__/sqlite-pragmas.spec.ts` reads the
 * value back.
 */
export const SQLITE_WAL_AUTOCHECKPOINT_BOUND_PAGES = 10_000

/**
 * ## 2026-08-25 — both numbers above had become numbers for a different database
 *
 * Everything above was sized against a **130 MB** file. The live hub's
 * `camstack.db` is **858 MB** (900,124,672 bytes on disk) and the two knobs had
 * not moved: a 64 MiB cache covering 7% of the file instead of the ~50% the
 * sizing argued for, and a 256 MiB map covering its first 30%.
 *
 * The consequence was measured on the live runner, not inferred.
 * `hub/sqlite-settings` is a fork with ONE JS thread and a synchronous binding,
 * and it reported `loopMax` of 11-68 s in every 5-minute sample while the
 * container had **zero** memory pressure (`memory.events max` 0/min) and the
 * NVMe was idle (`%util` 1.5-8%, `r_await` 0.14 ms) — so neither previously
 * known cause applied. A 120 s census of its main thread (2,216 samples):
 *
 *     D (uninterruptible I/O) 41%   R (runnable) 50%   S (idle) 9%
 *     CPU consumed: 13.9 s of 120 s wall
 *
 * and the kernel stack during every D sample was:
 *
 *     pread64 -> vfs_read -> filemap_read -> filemap_get_pages -> folio_wait_bit_common
 *
 * `/proc/<pid>/syscall` named the file and the arguments: fd -> `camstack.db`,
 * count `0x1000` (one SQLite page), at a sustained **418 read syscalls/s**. And
 * every sampled offset — 0x14480000, 0x1bb81000, 0x1d216000, 0x2f866000,
 * 0x2fecf000 … — was **beyond 0x10000000**, i.e. outside the 256 MiB map. Not
 * one below it. The runner was paying a synchronous disk round trip, on the
 * thread every cluster-wide configuration read queues behind, for the 70% of
 * its own database it had stopped mapping.
 *
 * So the fix is not a bigger constant — a constant is what expired. Both knobs
 * now derive from the measured file, with a floor (never worse than the sizing
 * already argued for) and a ceiling (a runaway database must not pin unbounded
 * memory in a container that has OOM'd before).
 */

/** Bytes in one MiB, so the arithmetic below reads in the units it is argued in. */
const MIB = 1_048_576

/**
 * Multiple of the database size to map.
 *
 * Deliberately above 1: `mmap_size` is a ceiling on what SQLite will map, not
 * an allocation, and a window sized exactly to today's file stops covering the
 * tail the moment the next row lands — which is precisely how the 256 MiB
 * constant expired. The map costs virtual address space and file-backed page
 * cache, never anonymous memory, so overshooting is close to free while
 * undershooting costs a syscall per page.
 */
const MMAP_SIZE_MULTIPLE = 1.25

/**
 * Hard ceiling on the map, in bytes. 2 GiB.
 *
 * Not a memory budget — mapped pages are reclaimable — but a bound on how far
 * an unattended database may drift before somebody has to look at it. A file
 * past this is a retention problem and should be reported as one, not absorbed
 * silently by a wider window.
 */
export const SQLITE_MMAP_CEILING_BYTES: number = 2 * 1024 * MIB

/**
 * Share of the database to hold in SQLite's OWN page cache.
 *
 * 0.25, not the 0.5 the 130 MB sizing used, and the difference is the point:
 * this cache is `malloc`'d C memory — anonymous and NOT reclaimable — in a
 * container measured at 20.9 GB of a 24 GB ceiling. Half of 858 MB would be
 * 429 MB of unreclaimable RSS on one runner, trading a stall for the memory
 * pressure another fix had just removed.
 *
 * A quarter is what the measurement supports: 418 misses/s x 4 KiB is ~1.7 MB/s,
 * so a 60 s window touches on the order of 100 MB of distinct pages. 214 MiB at
 * the live size covers that working set with headroom, without pretending to
 * cache the whole file.
 */
const PAGE_CACHE_SIZE_SHARE = 0.25

/**
 * Ceiling on SQLite's page cache, in KiB (negative — see
 * {@link SQLITE_PAGE_CACHE_FLOOR_KIB} for why the sign matters). 256 MiB.
 *
 * This is the number bounding unreclaimable growth, so it is the one that must
 * not be generous. Past it the answer is retention, not RAM.
 */
export const SQLITE_PAGE_CACHE_CEILING_KIB = -262_144

/**
 * A size that is missing, negative or non-finite means "unknown", never zero:
 * a first boot has no file yet, and an unreadable `stat` must not be able to
 * configure the engine DOWN from the floor.
 */
function usableSize(fileSizeBytes: number): number {
  return Number.isFinite(fileSizeBytes) && fileSizeBytes > 0 ? fileSizeBytes : 0
}

/** The `mmap_size` to apply for a database of this size, in bytes. */
export function sqliteMmapSizeFor(fileSizeBytes: number): number {
  const wanted = Math.round(usableSize(fileSizeBytes) * MMAP_SIZE_MULTIPLE)
  return Math.min(Math.max(wanted, SQLITE_MMAP_FLOOR_BYTES), SQLITE_MMAP_CEILING_BYTES)
}

/** The `cache_size` to apply for a database of this size, in KiB (negative). */
export function sqlitePageCacheKibFor(fileSizeBytes: number): number {
  const wantedKib = Math.round((usableSize(fileSizeBytes) * PAGE_CACHE_SIZE_SHARE) / 1024)
  const bounded = Math.min(
    Math.max(wantedKib, Math.abs(SQLITE_PAGE_CACHE_FLOOR_KIB)),
    Math.abs(SQLITE_PAGE_CACHE_CEILING_KIB),
  )
  return -bounded
}

/** Page counters read straight off the connection, in the units SQLite reports. */
export interface SqlitePageCounters {
  readonly pageCount: number
  readonly freelistCount: number
  readonly pageSizeBytes: number
}

/** How much of the file holds rows, and how much is free pages awaiting reuse. */
export interface SqliteOccupancy {
  readonly liveMb: number
  readonly freeMb: number
  readonly freePct: number
}

/**
 * Split a database file into live bytes and free bytes.
 *
 * A file that stopped growing is not the same as a file that is full. SQLite
 * reuses freed pages but never returns them to the filesystem without a
 * `VACUUM`, so a database sitting at its high-water mark looks — from `stat`,
 * from `df`, from any measurement outside the connection — exactly like one
 * genuinely packed with rows. The two call for opposite actions: the first is
 * reclaimed by a VACUUM, the second means retention is not keeping up.
 *
 * `dbSizeMb` on the boot line could not tell them apart. This can, and it costs
 * three header reads on a connection that is already open.
 */
export function sqliteOccupancy(counters: SqlitePageCounters): SqliteOccupancy {
  const { pageCount, freelistCount, pageSizeBytes } = counters
  if (pageCount <= 0 || pageSizeBytes <= 0) return { liveMb: 0, freeMb: 0, freePct: 0 }
  const free = Math.min(freelistCount, pageCount)
  return {
    liveMb: Math.round(((pageCount - free) * pageSizeBytes) / 1_048_576),
    freeMb: Math.round((free * pageSizeBytes) / 1_048_576),
    freePct: Math.round((free / pageCount) * 100),
  }
}

/**
 * How often the connection re-checks whether the file has outgrown its map.
 *
 * The database grows by roughly 40 MB a day on this cluster, so five minutes is
 * far finer than it needs to be — but the check is three arithmetic operations
 * on a `stat`, and the failure it prevents is a node silently returning to
 * 418 synchronous page-ins per second. Cheap insurance against a slow leak.
 */
export const MAP_GROWTH_CHECK_INTERVAL_MS: number = 5 * 60_000

/**
 * The new `mmap_size` when the file has outgrown the current one, or `null`.
 *
 * `sqliteMmapSizeFor` already autoscales to any user's database — but it is
 * applied when the connection OPENS and never again, which is the same bug one
 * level up: a file that grows during uptime keeps the map it had at boot. This
 * node escaped it only because 130 MB → 858 MB spanned seventeen days of
 * restarts; a node up for two months walks straight back into 70% of the file
 * outside the map.
 *
 * GROWTH only. Shrinking after a delete buys nothing and costs a remap, and the
 * file does not shrink without a `VACUUM` regardless — measured 2026-08-25,
 * `freePct=1` on an 858 MB file that had been deleting rows for days.
 */
export function resolveMapGrowth(currentMmapBytes: number, fileSizeBytes: number): number | null {
  if (fileSizeBytes <= 0) return null
  const wanted = sqliteMmapSizeFor(fileSizeBytes)
  return wanted > currentMmapBytes ? wanted : null
}
