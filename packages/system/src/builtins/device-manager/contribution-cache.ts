/**
 * The device-details fan-out, made survivable: budgeted, cached, single-flight.
 *
 * ## What it is for
 *
 * `getDeviceAggregate` asks every contributing provider for this device's
 * settings panel and waits for all of them. Measured on this hub (2026-09-14):
 * 10 595 ms on a battery camera against 331 ms on a mains one, while the page
 * re-polls every 2 500 ms. One slow contributor stalled the whole device page,
 * the poll stacked a fresh 10 s call on top of the one still running, and not
 * one line named which provider was holding it.
 *
 * ## Why a budget alone would have been worse
 *
 * Dropping the provider that overran makes its settings SECTION disappear and
 * come back between polls. A section of settings that flickers is worse than a
 * slow one — and it is also what moved the operator's page: the schema loses a
 * tab for a beat, and everything downstream reacts to a tab that is not there.
 *
 * So the budget is paired with the last answer that provider gave. A slow
 * provider costs the page its budget ONCE; after that the page is instant and
 * shows what that provider last said, until it says something new.
 *
 * ## The rules
 *
 * - **A read never joins a refresh already in flight** (D224). Without this the
 *   2.5 s poll starts a new 10 s call every tick and they pile up.
 * - **An explicit `null` is an ANSWER**, not a miss: it means "I have nothing
 *   for this device", and it replaces what was cached. A cache that only ever
 *   remembers successes would serve a stale panel around a provider that has
 *   since disowned the device.
 * - **A failure falls back**, but a failure with nothing behind it is ABSENT
 *   and says which of the two it was — "never answered" and "answered once and
 *   is now broken" are different operator problems.
 */

/** How long the page waits for ONE provider before serving what it has. */
export const CONTRIBUTION_BUDGET_MS = 1_500

/**
 * Entries held across all devices. A device page touches a dozen or so, and an
 * operator walks a fleet — bounded so a long session cannot grow it without
 * limit. Oldest-inserted is evicted first; a re-read of an evicted key simply
 * pays the budget again.
 */
export const CONTRIBUTION_CACHE_MAX_ENTRIES = 512

/**
 * How long a read waits for a provider's answer when the entry was WRITTEN to
 * since it last answered. Longer than the page budget on purpose: right after a
 * write the only honest answers are the provider's new one or "not yet" — the
 * last cached answer is the pre-write view, and showing it is how a saved
 * setting appeared to snap back.
 */
export const WRITE_READBACK_BUDGET_MS = 8_000

/** How a single provider's contribution was resolved. */
export type ContributionOutcome<T> =
  | { readonly kind: 'fresh'; readonly value: T | null }
  | { readonly kind: 'stale'; readonly value: T }
  | { readonly kind: 'absent'; readonly reason: 'slow' | 'failed' }

interface Entry<T> {
  /** The last ANSWER, `null` included — absent from the map means never asked. */
  value: T | null
  /** In-flight refresh, so a second read is answered rather than queued. */
  inFlight: Promise<void> | null
  /** Bumped by every write; a call only records its answer if it began after the last one. */
  generation: number
  /** True from a write until a call that began after it has answered. */
  written: boolean
}

export class ContributionCache<T = unknown> {
  private readonly entries = new Map<string, Entry<T>>()

  constructor(private readonly maxEntries: number = CONTRIBUTION_CACHE_MAX_ENTRIES) {}

  /**
   * Resolve one provider's contribution within `budgetMs`.
   *
   * The call is never cancelled: it keeps running and its answer refreshes the
   * cache, so the provider that overran this page pays for the next one.
   */
  async resolve(
    key: string,
    call: () => Promise<T | null>,
    budgetMs: number = CONTRIBUTION_BUDGET_MS,
    readbackBudgetMs: number = WRITE_READBACK_BUDGET_MS,
  ): Promise<ContributionOutcome<T>> {
    const existing = this.entries.get(key)

    // Already refreshing: answer from what we hold. Starting a second call is
    // how the poll turned one slow provider into a growing pile of them.
    // EXCEPT a call that began before a write: its answer is the pre-write
    // view, so joining it (or serving the value it is about to replace) is the
    // snap-back. A write supersedes it; the call below is bounded by writes,
    // not by polls.
    if (existing?.inFlight && !existing.written) {
      return existing.value !== null
        ? { kind: 'stale', value: existing.value }
        : { kind: 'absent', reason: 'slow' }
    }

    const entry: Entry<T> = existing ?? {
      value: null,
      inFlight: null,
      generation: 0,
      written: false,
    }
    if (!existing) this.remember(key, entry)
    const generation = entry.generation
    const afterWrite = entry.written

    let settled = false
    let answer: T | null = null
    let failed = false
    // The in-flight flag is cleared INSIDE both handlers rather than in a
    // `.finally()`: `finally` is one more microtask, and a caller that reads
    // immediately after the answer landed would still be told a refresh is
    // running and be served the value it just wrote, as stale.
    const refresh = call().then(
      (value) => {
        answer = value
        settled = true
        // A call that a write overtook answers for the pre-write view: it is
        // handed to its own caller (who asked before the write) and never
        // recorded, and it must not clear the flag of the call that replaced it.
        if (entry.generation !== generation) return
        entry.value = value
        entry.inFlight = null
        entry.written = false
      },
      () => {
        failed = true
        settled = true
        if (entry.generation !== generation) return
        entry.inFlight = null
        // The previous answer stands. A provider that throws has not disowned
        // the device — it has failed to say anything about it.
      },
    )
    entry.inFlight = refresh

    await Promise.race([refresh, sleep(afterWrite ? readbackBudgetMs : budgetMs)])

    if (settled && !failed) return { kind: 'fresh', value: answer }
    // Written to since it last answered: the held value is the pre-write view.
    if (entry.value !== null && !entry.written) return { kind: 'stale', value: entry.value }
    return { kind: 'absent', reason: failed ? 'failed' : 'slow' }
  }

  /**
   * Record that the provider behind `key` was written to. What the cache holds
   * for it is now the pre-write view: it is never served again, a call already
   * in flight no longer counts as a refresh to wait for, and the next read asks
   * afresh and is given {@link WRITE_READBACK_BUDGET_MS} to be answered.
   */
  markWritten(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    entry.generation += 1
    entry.written = true
    entry.inFlight = null
  }

  /** {@link markWritten} for every held key the predicate accepts. */
  markWrittenWhere(matches: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) {
      if (matches(key)) this.markWritten(key)
    }
  }

  private remember(key: string, entry: Entry<T>): void {
    this.entries.set(key, entry)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
