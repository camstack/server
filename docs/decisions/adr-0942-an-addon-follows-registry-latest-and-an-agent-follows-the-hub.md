---
id: D942
title: An addon follows registry latest, and an agent follows the hub
status: accepted
date: 2026-10-25
supersedes:
applies-to:
  - packages/system/src/kernel/addon-version-policy.ts
  - packages/system/src/kernel/addon-installer.ts
  - server/backend/src/core/addon/addon-package.service.ts
  - server/backend/src/core/agent/agent-addon-backfill.ts
  - server/backend/src/agent/agent-hub-addon-update.ts
---

## Context

The hub's auto-update applied an addon only when the registry tag was a
strictly newer semver. That gate was written on 2026-07-22, after a `!==`
comparison replaced same-day workspace deploys with the older published
tarball. It lived in `runAutoUpdate` and was never its own record.

The operator's rule on 2026-10-25 is the other way: wrappers install the
latest available addon version, and a line that is restarted — `latest`
moving down — is followed too. A forward-only gate leaves every node that
took a newer label stuck there after the registry is rolled back.

D175's rule for the **framework** row is a different question and stays: a
framework announcement is still strictly newer, because a `-dev` build ahead
of the npm tag must not be offered as a downgrade of `@camstack/server`.
D15's host-provided skew stays too: `@camstack/system` is still not seeded
into the addon root when the closure provides it. D840 stays: an agent does
not ask npm.

## Decision

The target version of an addon on the hub is the npm dist-tag `latest` of
that package (the `beta` channel still prefers `beta`, then `latest`). First
install, a required-package install on the npm source, the availability
diff and the auto-update sweep all use that target. An installed version
that differs — higher or lower — is moved to it. Every move is logged with
from, to and the reason.

An agent does not resolve `latest` itself. Its target is the hub's installed
version, and a live copy that differs from that version is brought to it,
again in either direction. The agent's Update asks the hub for that version
and does not call the registry.

A failed or empty read changes nothing (D49). No dist-tag, a non-ok registry
response, a thrown fetch, or a hub version the map does not contain is not a
version, and it is never treated as "install nothing" in the direction that
would remove a package. The health check and the rollback copy on a failed
`updatePackage` (`confirmOrRetainBackup`, `applyUpdate`) stay.

A workspace or bundled seed (`installSource` local or symlink) is the
checkout the process is running from, not a registry install, and is not
moved at boot.

## Consequences

- A CLI deploy whose `package.json` version is not the current `latest` is
  replaced on the next hub auto-update that is allowed to run, and an agent
  copy that is not the hub's version is replaced on the next delivering
  reconcile. That is the 2026-07-22 outcome, now on purpose.
- The auto-update **channel** still decides whether the sweep installs.
  `channel: off` does not apply. Required packages on the npm source are
  reconciled at boot regardless of that channel.
- Boot re-alignment to a strictly newer closure copy (the closure plan) is
  unchanged. It runs after the latest-follow, and a copy just written is
  newer than the closure's landing time, so it is kept.
- No manifest required-version pin and no `updatePackage` input default
  named a version. Nothing was removed there. `CAP_INPUT_DEFAULTS` has no
  addon version field.

## Enforcement

`decideAddonVersionMove` is the comparison. Specs cover a higher latest, a
lower latest with a log line, an unreadable registry, and an agent that
asks the hub rather than npm. Nothing else checks the rule.
