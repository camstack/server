---
id: D274
title: The fleet-list caching window is owned by the query client, not the call site
status: accepted
date: 2026-08-28
supersedes:
applies-to:
  - packages/ui-library/src/lib/fleet-query-defaults.ts
  - packages/addon-admin-ui/src/hooks/useDevice.ts
---

## Context

`deviceManager.listAll` is the most-read query in the admin UI: 26 call sites
across the sidebar search, Devices, Integrations, Recordings, Scenes, Retrain,
the detection-intelligence sections and four ui-library pickers. On the
reference hub it answers for 1017 devices.

The server side of this query was cut from 4,987,368 fleet rows to 22,933. The
client kept asking anyway.

The reason is that `staleTime` is a **per-OBSERVER** setting, not a property of
the cache entry. `QueryClient.defaultQueryOptions` resolves it once for every
mounted observer as

```
{ ...defaultOptions.queries, ...getQueryDefaults(queryKey), ...callSiteOptions }
```

so a single observer that leaves `staleTime` at the app-wide default of `0`
refetches the shared key on mount regardless of what its siblings passed. The
app-wide default is `staleTime: 0, gcTime: 0` — a deliberate "no
cross-navigation cache" choice — which makes every omission a refetch.

**What was tried first, and drifted.** The previous pass fixed this by hand at
the call site, 21 times, copying `staleTime: 30_000` from the docblock in
`GlobalSearch.tsx:65` that explains the trap. It had already drifted before it
shipped: all six ui-library composites were missed, and those are the ones
asking for the UNPROJECTED fleet — including `device-export-panel.tsx:278`,
which polls it every 5 seconds. 21 hand-edits are 21 chances to forget, and
forgetting is silent: the UI still works, it just asks again.

Two further facts shaped the window rather than the mechanism:

- **Simultaneous mounts were never the problem.** query-core already dedupes
  observers that mount in the same tick onto one in-flight fetch. The real cost
  is *staggered* mounts — a lazily code-split route chunk, a modal opened a
  second later, a tab switched into — and re-navigation, where `gcTime: 0`
  evicts the entry the moment its last observer leaves. An evicted entry cannot
  be stale-served no matter what `staleTime` says.
- **Invalidation is comprehensive, so a window is safe.** ~20 mutation
  `onSuccess` handlers invalidate the `[['deviceManager']]` prefix, which covers
  `listAll` under every input. An operator edit is therefore never what a
  window makes stale. One outlier was found and fixed while establishing this:
  `useUpdateDeviceConfig` filtered on `['deviceManager']` — single-nested, so it
  compared a string against a tRPC key whose first element is an array, and
  matched no generated query at all. Its docblock claimed the opposite.

## Decision

The caching window for `deviceManager.listAll` is registered **once**, on the
query client, by `applyFleetQueryDefaults` — `staleTime: 30_000`,
`gcTime: 5 min`, scoped to the `[['deviceManager', 'listAll']]` key prefix. Every
`QueryClient` that can mount a fleet consumer calls it immediately after
construction. No call site declares a window of its own.

The window is 30 s because invalidation, not expiry, is what keeps an edited
device fresh; what the window actually bounds is the change no client mutation
announces — a provider discovering a camera, a device dropping offline, a scan
adding rows. The `gcTime` is scoped to this one key and leaves the app-wide
`gcTime: 0` untouched.

## Consequences

- `setQueryDefaults` matches by key PREFIX, so one registration covers every
  `input` variant (`{}`, `{ projection: 'slim' }`,
  `{ isCamera: true, projection: 'slim' }`) and every future call site. Call
  site 44 gets the window without knowing it exists.
- Call-site options still sit last in the merge, so a surface that genuinely
  needs live data keeps its escape hatch. Two use `refetchInterval` today and
  are unaffected.
- The registration lives on the client, so a surface that builds its OWN
  `QueryClient` silently opts out. There are three today; a fourth must apply
  the defaults, and the guard is what makes that non-optional.
- A device that appears without any client mutation can be up to 30 s late on a
  surface already open. That is the accepted cost.

## Enforcement

`scripts/check-fleet-query-defaults.ts`, wired into `.github/workflows/ci.yml`.
It fails on a `new QueryClient(` in the UI trees that does not apply the
defaults, and on a `useDeviceManagerListAll` call whose own argument list
declares `staleTime`/`gcTime`. Both directions were verified to fail before the
guard was committed.

The outcome itself is pinned by
`packages/ui-library/src/lib/__tests__/fleet-query-defaults.spec.tsx`, which
counts `queryFn` invocations through a real client rather than asserting that a
prop was passed: 5 staggered observers produce 1 fetch (5 without the
registration), and a mount → unmount → mount produces 1 (2 without). It also
pins the non-goal — same-tick mounts dedupe with or without this — so the suite
cannot go green for the ambient reason.
