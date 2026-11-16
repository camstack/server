---
id: D1055
title: A node shell lives only while its node's section is open
status: accepted
date: 2026-11-16
supersedes:
applies-to:
  - packages/addon-admin-ui/src/pages/system/Terminal.tsx
  - packages/addon-admin-ui/src/pages/system/terminal/NodeShells.tsx
  - packages/addon-admin-ui/src/pages/system/terminal/use-node-shell-session.ts
---

## Context

The first node-shell page (D1051) was a full page per node that reattached an
existing `server-shell` session or opened one, and left it running when the
admin navigated away ("it stays open after you leave"). The Terminal page
listed every pty of a node in one "Live sessions" list, so node shells sat in
the same list as the Terminal instances exported as cameras. The operator
rejected both: terminal devices and node shells are different things, and a
node's shell should exist only while an admin is in that node's section.

## Decision

The Terminal page has two sub-sections, "Terminal devices" and "Node shells",
and a node shell never appears in the first. "Node shells" lists one entry per
node the capability registry answered runs a provider; listing starts
nothing. A node's `server-shell` session is opened when an admin opens that
node's section and closed when the section is left (another node, Close, the
tab or the page) or the page is hidden. The UI never reattaches a shell it
did not open. A tab killed outright closes nothing; the provider's idle
timeout (D1051) is the bound for that case.

Rejected: keeping the shell alive after leaving and reattaching it on return.
It left shells running nobody was looking at until the idle timeout, and made
"which admin is in this shell" unanswerable from the page.

## Consequences

The four controls of D1051 (admin only, per-node opt-in, audit, idle timeout)
are unchanged and still enforced by the provider. Leaving the section kills
the shell's state (working directory, running command); an admin who wants a
long job keeps the section open or uses a Terminal instance. An opened shell
costs one audit line per visit.

## Enforcement

`packages/addon-admin-ui/src/pages/system/terminal/__tests__/NodeShells.spec.tsx`:
the list opens nothing; opening a section opens exactly one `server-shell`;
an opted-out node opens nothing; Close, unmount, and a shell that answers
after the section was left are each closed. `Terminal.spec.tsx`: a
`server-shell` session is never listed among the devices' live sessions.
