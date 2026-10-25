/**
 * `AudioClassifyQueue` — every camera's windows through ONE inference
 * pipeline, fairly, without dropping any of them silently (D660).
 *
 * ## Why this exists
 *
 * One YAMNet subprocess (or one Apple SoundAnalysis CLI) serves every camera
 * a node analyses — ~23 on the hub. It is single-channel: one inference at a
 * time. Windows arrive from per-camera pollers (200–500 ms) in bursts, so
 * several cameras routinely hand a window over within the same few
 * milliseconds. Until D660 a global busy flag answered every window that lost
 * that race with an empty result, and a per-camera 500 ms gate dropped the
 * rest of a camera's backlog: live on 2026-09-27, 1–10% of windows were
 * labelled on every camera while the model sat at 7.5% CPU — starved, not
 * overloaded.
 *
 * ## The rules
 *
 *  - At most ONE pending window per camera. A newer window from the same
 *    camera SUPERSEDES the pending one and inherits its place in line. That is
 *    the only drop, it is answered (`superseded`) rather than faked, and it is
 *    counted.
 *  - Cameras are served in ARRIVAL order (a `Map` iterates in insertion
 *    order, and replacing a key keeps its position). A camera sending faster
 *    than inference therefore keeps its turn and cannot be starved by being
 *    fast, and no camera waits behind more than one window of each other
 *    camera — the bound is the camera count, not the backlog.
 *  - There is no per-camera minimum interval. The 500 ms one it replaced
 *    existed to stop a camera "immediately re-queuing" after its own
 *    inference; with a FIFO it re-queues BEHIND everyone already waiting,
 *    which is the fairness the interval approximated. A window is ~1 s of
 *    audio, so a camera cannot sustain more than ~1 window/s anyway; the
 *    interval only ever bit on a poll batch that flushed two windows at once
 *    — exactly the burst it then discarded.
 */

/** Why a submitted job never ran. */
export type AudioClassifySkipReason = 'superseded' | 'disposed'

/** What one submission came to. A thrown job rejects the submission instead. */
export type AudioClassifySubmission<R> =
  | { readonly ran: true; readonly value: R }
  | { readonly ran: false; readonly reason: AudioClassifySkipReason }

/** Per-camera counts since the last {@link AudioClassifyQueue.takeAccounting}. */
export interface AudioClassifyAccounting {
  readonly key: number
  readonly classified: number
  readonly superseded: number
  readonly errors: number
  readonly disposed: number
}

interface PendingJob<R> {
  readonly run: () => Promise<R>
  readonly settle: (outcome: AudioClassifySubmission<R>) => void
  readonly fail: (err: unknown) => void
}

interface MutableCounts {
  classified: number
  superseded: number
  errors: number
  disposed: number
}

function emptyCounts(): MutableCounts {
  return { classified: 0, superseded: 0, errors: 0, disposed: 0 }
}

export class AudioClassifyQueue<R> {
  /** Pending job per camera, in arrival order. */
  private readonly pending = new Map<number, PendingJob<R>>()
  private readonly counts = new Map<number, MutableCounts>()
  private running = false
  private closed = false

  /** True while an inference is running or a window is waiting for one. */
  get busy(): boolean {
    return this.running || this.pending.size > 0
  }

  /**
   * Queue `run` for camera `key`. Resolves when it ran (`ran: true`), or when
   * it was superseded / the queue closed first (`ran: false`). A job that
   * throws rejects this promise with its error, and is counted as an error.
   */
  submit(key: number, run: () => Promise<R>): Promise<AudioClassifySubmission<R>> {
    if (this.closed) {
      this.count(key, 'disposed')
      return Promise.resolve({ ran: false, reason: 'disposed' })
    }
    return new Promise<AudioClassifySubmission<R>>((resolve, reject) => {
      const previous = this.pending.get(key)
      if (previous) {
        this.count(key, 'superseded')
        previous.settle({ ran: false, reason: 'superseded' })
      }
      // `set` on an existing key keeps its position: the newer window
      // inherits the older one's place in line.
      this.pending.set(key, { run, settle: resolve, fail: reject })
      void this.drain()
    })
  }

  /**
   * Hand back, and reset, the per-camera counts for every camera that had any
   * activity since the last call.
   */
  takeAccounting(): readonly AudioClassifyAccounting[] {
    const out: AudioClassifyAccounting[] = []
    for (const [key, c] of this.counts) {
      out.push({ key, ...c })
    }
    this.counts.clear()
    return out
  }

  /** Answer every waiting window `disposed` and refuse new ones. */
  close(): void {
    this.closed = true
    for (const [key, job] of this.pending) {
      this.count(key, 'disposed')
      job.settle({ ran: false, reason: 'disposed' })
    }
    this.pending.clear()
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const next = this.pending.entries().next()
        if (next.done === true) return
        const [key, job] = next.value
        this.pending.delete(key)
        try {
          const value = await job.run()
          this.count(key, 'classified')
          job.settle({ ran: true, value })
        } catch (err: unknown) {
          this.count(key, 'errors')
          job.fail(err)
        }
      }
    } finally {
      this.running = false
    }
  }

  private count(key: number, field: keyof MutableCounts): void {
    const c = this.counts.get(key) ?? emptyCounts()
    c[field] += 1
    this.counts.set(key, c)
  }
}
