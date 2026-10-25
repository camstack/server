/**
 * The container-memory probe.
 *
 * Five claims are load-bearing, and each one exists because the alternative is
 * a lie this repo has already been bitten by:
 *
 *  1. **The parse is right against a REAL `memory.stat`** — the live hub's own
 *     file, ~50 fields deep, of which we read five. A kernel that adds a sixth
 *     must not become a parse failure.
 *  2. **Absent is ABSENT.** A node with no cgroup produces `null`, never a
 *     snapshot of zeros. A zeroed reading is indistinguishable from a healthy
 *     container and would be charted as one.
 *  3. **The GPU read degrades.** debugfs is not mounted inside any camstack
 *     container (verified on the live hub, 2026-08-29) and a node with no
 *     Intel GPU has no such file at all. It must read `unknown`, never throw,
 *     and never cost a syscall per tick.
 *  4. **The path is DISCOVERED, never hard-coded.** From inside the container
 *     the cgroup is at the mount root; from the host the same cgroup is at
 *     `/sys/fs/cgroup/docker/<id>`. Hard-coding either breaks the other.
 *  5. **A failing tick logs the TRANSITION, not the tick.** At the 10 s
 *     cadence a per-tick warning is 8 640 lines a day on a node that simply is
 *     not Linux.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildContainerMemorySnapshot,
  ContainerMemoryProbe,
  I915_GEM_OBJECTS_PATH,
  parseCgroupScalar,
  parseCgroupSelf,
  parseCgroupStat,
  parseI915GemObjects,
  resolveCgroupMemoryLayout,
  type CgroupFileReader,
} from '../cgroup-memory.js'

/**
 * The live hub's own `memory.stat`, cgroup v2, read on 2026-08-29 from inside
 * the `CamStack` container. Trimmed in the middle only — every field we read
 * is present, and so are plenty we do not, which is the point: the parse must
 * survive a file it does not fully understand.
 */
const V2_MEMORY_STAT = `anon 19946409984
file 3642105856
kernel 429236224
kernel_stack 22036480
pagetables 311418880
sec_pagetables 0
percpu 31856
sock 24518656
vmalloc 24576
shmem 1860067328
file_mapped 185208832
file_dirty 742604800
file_writeback 1138688
swapcached 0
anon_thp 144703488
file_thp 0
shmem_thp 2097152
inactive_anon 19915505664
active_anon 30965760
inactive_file 1312735232
active_file 469303296
unevictable 1860345856
slab_reclaimable 61756472
slab_unreclaimable 33709456
slab 95465928
workingset_refault_anon 0
workingset_refault_file 362083
pgscan 3068190
pgsteal 2423661
pgfault 233250070
pgmajfault 21686
thp_fault_alloc 6477
numa_hint_faults 0
`

/** A cgroup v1 `memory.stat`. Different names, fewer of them, no slab at all. */
const V1_MEMORY_STAT = `cache 3642105856
rss 19946409984
rss_huge 144703488
shmem 1860067328
mapped_file 185208832
dirty 742604800
writeback 1138688
pgpgin 12345678
pgpgout 8765432
inactive_anon 19915505664
active_anon 30965760
hierarchical_memory_limit 34359738368
`

/** The live host's first line of `i915_gem_objects`, read 2026-08-29. */
const I915_FIRST_LINE = `6014 shrinkable [0 free] objects, 1194934272 bytes
system: total:0x0000000f91af9000 bytes
stolen-local: total:0x0000000008000000 bytes
`

interface LoggedLine {
  readonly level: 'info' | 'warn'
  readonly message: string
}

/** A logger that records, so "logged once" is an assertion and not a hope. */
function recordingLogger(sink: LoggedLine[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: (message: string) => sink.push({ level: 'info', message }),
    warn: (message: string) => sink.push({ level: 'warn', message }),
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/** An in-memory filesystem. Any path not present reads `null`, like the real one. */
function fakeFs(files: Readonly<Record<string, string>>): CgroupFileReader & {
  readonly reads: string[]
} {
  const reads: string[] = []
  return {
    reads,
    read(path: string): string | null {
      reads.push(path)
      return files[path] ?? null
    },
  }
}

/** Exactly what the live hub looks like from INSIDE its own container. */
const NAMESPACED_V2: Readonly<Record<string, string>> = {
  '/proc/self/cgroup': '0::/\n',
  '/sys/fs/cgroup/memory.current': '24045301760\n',
  '/sys/fs/cgroup/memory.max': '34359738368\n',
  '/sys/fs/cgroup/memory.stat': V2_MEMORY_STAT,
}

describe('parsing a real memory.stat', () => {
  it('reads the five fields we want out of a v2 file full of ones we do not', () => {
    const stat = parseCgroupStat(V2_MEMORY_STAT)
    expect(stat.get('anon')).toBe(19946409984)
    expect(stat.get('file')).toBe(3642105856)
    expect(stat.get('shmem')).toBe(1860067328)
    expect(stat.get('slab')).toBe(95465928)
    // The fields we never read are parsed rather than refused — an unknown key
    // is not an error, it is a kernel we do not fully know.
    expect(stat.get('numa_hint_faults')).toBe(0)
    expect(stat.size).toBeGreaterThan(30)
  })

  it('maps a v2 reading onto the reported shape, in bytes', () => {
    const snapshot = buildContainerMemorySnapshot({
      source: 'cgroup-v2',
      currentText: '24045301760\n',
      limitText: '34359738368\n',
      statText: V2_MEMORY_STAT,
      gpuShmemBytes: null,
    })
    expect(snapshot).toEqual({
      source: 'cgroup-v2',
      currentBytes: 24045301760,
      limitBytes: 34359738368,
      anonBytes: 19946409984,
      fileBytes: 3642105856,
      shmemBytes: 1860067328,
      slabBytes: 95465928,
      gpuShmemBytes: null,
    })
  })

  it('falls back to the two slab halves when a kernel publishes no `slab`', () => {
    const withoutSlab = V2_MEMORY_STAT.split('\n')
      .filter((line) => !line.startsWith('slab '))
      .join('\n')
    const snapshot = buildContainerMemorySnapshot({
      source: 'cgroup-v2',
      currentText: '1',
      limitText: null,
      statText: withoutSlab,
      gpuShmemBytes: null,
    })
    // 61756472 + 33709456 — exact, not an approximation.
    expect(snapshot?.slabBytes).toBe(95465928)
  })

  it('maps a v1 reading onto the SAME field names, and reports no slab as UNKNOWN', () => {
    const snapshot = buildContainerMemorySnapshot({
      source: 'cgroup-v1',
      currentText: '24045301760\n',
      limitText: '9223372036854771712\n',
      statText: V1_MEMORY_STAT,
      gpuShmemBytes: null,
    })
    expect(snapshot?.anonBytes).toBe(19946409984)
    expect(snapshot?.fileBytes).toBe(3642105856)
    expect(snapshot?.shmemBytes).toBe(1860067328)
    // v1 publishes no slab accounting. UNKNOWN, and never 0 — a zero here
    // would read as "this kernel charges no slab", which is not a thing.
    expect(snapshot?.slabBytes).toBeNull()
    // And v1's "unlimited" sentinel is NOT a limit.
    expect(snapshot?.limitBytes).toBeNull()
  })

  it('reads `max` as NO LIMIT rather than as a number', () => {
    expect(parseCgroupScalar('max\n')).toBeNull()
    expect(parseCgroupScalar('34359738368\n')).toBe(34359738368)
    expect(parseCgroupScalar('')).toBeNull()
    expect(parseCgroupScalar('not-a-number')).toBeNull()
  })

  it('refuses to invent a reading when memory.current itself is unparseable', () => {
    expect(
      buildContainerMemorySnapshot({
        source: 'cgroup-v2',
        currentText: 'garbage',
        limitText: null,
        statText: V2_MEMORY_STAT,
        gpuShmemBytes: null,
      }),
    ).toBeNull()
  })
})

describe('finding the cgroup instead of hard-coding it', () => {
  it('reads the live hub layout: v2, unified, at the namespaced mount root', () => {
    const layout = resolveCgroupMemoryLayout(fakeFs(NAMESPACED_V2))
    expect(layout).toEqual({
      source: 'cgroup-v2',
      directory: '/sys/fs/cgroup',
      currentPath: '/sys/fs/cgroup/memory.current',
      limitPath: '/sys/fs/cgroup/memory.max',
      statPath: '/sys/fs/cgroup/memory.stat',
    })
  })

  it('follows the reported path when there is no cgroup namespace', () => {
    const layout = resolveCgroupMemoryLayout(
      fakeFs({
        '/proc/self/cgroup': '0::/docker/9f3c1a\n',
        '/sys/fs/cgroup/docker/9f3c1a/memory.current': '1234\n',
      }),
    )
    expect(layout?.directory).toBe('/sys/fs/cgroup/docker/9f3c1a')
    expect(layout?.statPath).toBe('/sys/fs/cgroup/docker/9f3c1a/memory.stat')
  })

  it('finds the v1 memory controller and its differently named files', () => {
    const layout = resolveCgroupMemoryLayout(
      fakeFs({
        '/proc/self/cgroup': '5:memory:/docker/9f3c1a\n4:cpu,cpuacct:/docker/9f3c1a\n',
        '/sys/fs/cgroup/memory/docker/9f3c1a/memory.usage_in_bytes': '1234\n',
      }),
    )
    expect(layout?.source).toBe('cgroup-v1')
    expect(layout?.currentPath).toBe('/sys/fs/cgroup/memory/docker/9f3c1a/memory.usage_in_bytes')
    expect(layout?.limitPath).toBe('/sys/fs/cgroup/memory/docker/9f3c1a/memory.limit_in_bytes')
  })

  it('prefers v2 on a hybrid host, because that is the hierarchy carrying the numbers', () => {
    const entry = parseCgroupSelf('5:memory:/legacy\n0::/unified\n4:cpu:/legacy\n')
    expect(entry).toEqual({ version: 'v2', path: '/unified' })
  })

  it('keeps a path that contains colons intact', () => {
    expect(parseCgroupSelf('0::/kubepods/pod:abc:def\n')).toEqual({
      version: 'v2',
      path: '/kubepods/pod:abc:def',
    })
  })

  it('resolves to NOTHING when no hierarchy answers', () => {
    // A developer Mac: there is no /proc/self/cgroup at all.
    expect(resolveCgroupMemoryLayout(fakeFs({}))).toBeNull()
    // A Linux host whose v2 mount is somewhere this build does not look: the
    // file names a hierarchy but nothing publishes the usage file.
    expect(resolveCgroupMemoryLayout(fakeFs({ '/proc/self/cgroup': '0::/\n' }))).toBeNull()
  })
})

describe('absent is ABSENT, never zero', () => {
  it('answers null on a node with no cgroup, and says so exactly once', () => {
    const lines: LoggedLine[] = []
    const probe = new ContainerMemoryProbe({ logger: recordingLogger(lines), fs: fakeFs({}) })

    expect(probe.sample()).toBeNull()
    expect(probe.sample()).toBeNull()
    expect(probe.sample()).toBeNull()
    expect(probe.available).toBe(false)

    // One line for the life of the process — not one per tick. At the 10 s
    // cadence the alternative is 8 640 lines a day saying "still not Linux".
    const resolution = lines.filter((l) => l.message.includes('no cgroup on this node'))
    expect(resolution).toHaveLength(1)
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(0)
  })

  it('resolves the cgroup ONCE and never re-probes /proc/self/cgroup', () => {
    const fs = fakeFs(NAMESPACED_V2)
    const probe = new ContainerMemoryProbe({
      logger: recordingLogger([]),
      fs,
      readGpu: false,
    })
    probe.sample()
    probe.sample()
    probe.sample()
    expect(fs.reads.filter((p) => p === '/proc/self/cgroup')).toHaveLength(1)
  })

  it('reports the whole reading on the live hub layout', () => {
    const probe = new ContainerMemoryProbe({
      logger: recordingLogger([]),
      fs: fakeFs(NAMESPACED_V2),
      readGpu: false,
    })
    expect(probe.sample()).toEqual({
      source: 'cgroup-v2',
      currentBytes: 24045301760,
      limitBytes: 34359738368,
      anonBytes: 19946409984,
      fileBytes: 3642105856,
      shmemBytes: 1860067328,
      slabBytes: 95465928,
      gpuShmemBytes: null,
    })
    expect(probe.available).toBe(true)
  })

  it('logs a cgroup that STOPS answering once, not once per tick', () => {
    const lines: LoggedLine[] = []
    const files: Record<string, string> = { ...NAMESPACED_V2 }
    const fs: CgroupFileReader = {
      read: (path: string): string | null => files[path] ?? null,
    }
    const probe = new ContainerMemoryProbe({
      logger: recordingLogger(lines),
      fs,
      readGpu: false,
    })
    expect(probe.sample()).not.toBeNull()

    delete files['/sys/fs/cgroup/memory.current']
    expect(probe.sample()).toBeNull()
    expect(probe.sample()).toBeNull()
    expect(probe.sample()).toBeNull()
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1)

    // …and recovery is a transition too, so an operator can see the window end.
    files['/sys/fs/cgroup/memory.current'] = '24045301760\n'
    expect(probe.sample()).not.toBeNull()
    expect(lines.filter((l) => l.message.includes('answering again'))).toHaveLength(1)
  })
})

describe('the GPU number degrades instead of failing', () => {
  it('reads the host figure when debugfs IS mounted', () => {
    const probe = new ContainerMemoryProbe({
      logger: recordingLogger([]),
      fs: fakeFs({ ...NAMESPACED_V2, [I915_GEM_OBJECTS_PATH]: I915_FIRST_LINE }),
    })
    expect(probe.sample()?.gpuShmemBytes).toBe(1194934272)
  })

  it('reads UNKNOWN — not zero, not a throw — when debugfs is absent', () => {
    // This is the live hub today: the file exists on the Unraid host and does
    // NOT exist inside the container where native-metrics runs.
    const probe = new ContainerMemoryProbe({
      logger: recordingLogger([]),
      fs: fakeFs(NAMESPACED_V2),
    })
    const snapshot = probe.sample()
    expect(snapshot).not.toBeNull()
    expect(snapshot?.gpuShmemBytes).toBeNull()
    // The rest of the reading is unaffected: an absent GPU figure must never
    // cost the container total.
    expect(snapshot?.currentBytes).toBe(24045301760)
  })

  it('probes debugfs ONCE and then stops touching it, and says why once', () => {
    const lines: LoggedLine[] = []
    const fs = fakeFs(NAMESPACED_V2)
    const probe = new ContainerMemoryProbe({ logger: recordingLogger(lines), fs })
    probe.sample()
    probe.sample()
    probe.sample()
    expect(fs.reads.filter((p) => p === I915_GEM_OBJECTS_PATH)).toHaveLength(1)
    expect(lines.filter((l) => l.message.includes('i915 GEM accounting'))).toHaveLength(1)
  })

  it('reads an unrecognised debugfs format as UNKNOWN', () => {
    expect(parseI915GemObjects(I915_FIRST_LINE)).toBe(1194934272)
    // The format has changed across kernel releases more than once.
    expect(parseI915GemObjects('42 objects, 100 bytes\n')).toBeNull()
    expect(parseI915GemObjects('')).toBeNull()
  })
})
