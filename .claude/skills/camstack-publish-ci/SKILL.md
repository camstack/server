---
name: camstack-publish-ci
description: Release CamStack through GitHub Actions — publish packages to npm (`Publish Packages`), then cut a release that builds the Docker image and the desktop app (`Release — CamStack (Docker + Electron)`). ALWAYS through CI, never a local publish. Covers the push-first and lockfile preflights, the workflow inputs (`include_dependents`, `force_packages` for a capability change, `publish_release`), npm registry lag, checking what a server closure pins, and the CI rules (never dispatch Checks). Use when shipping a batch to npm, cutting a product release from main, or a publish/release run failed.
---

# Publishing and releasing through CI

**Golden rule: never publish from a laptop.** `npm run publish` /
`scripts/publish.sh` publishes straight to public npm and is easy to get wrong
(its `--all` re-publishes every package; an interrupted run moves the registry
and not git). All publishing goes through GitHub Actions. Long form, with the
evidence behind each trap: `docs/architecture/update-and-release.md`
§"Publishing" and §"Cutting a release".

Two surfaces, in this ORDER:

1. **Packages → npm** — workflow `Publish Packages` (`.github/workflows/publish-packages.yml`).
2. **Release** — workflow `Release — CamStack (Docker + Electron)`
   (`.github/workflows/release.yml`): ONE Docker image
   `ghcr.io/<owner>/camstack:intel-X.Y.Z` (role chosen at runtime by
   `CAMSTACK_ROLE`) and ONE desktop app (`packages/desktop`, `CamStack-X.Y.Z-<arch>.*`).

The release installs from npm (the image `@camstack/server@latest`, the
desktop `@camstack/server@X.Y.Z`), so step 1 must have LANDED first.

Getting the published closure onto running nodes is not this skill: it is
`applyServerUpdate` per node — `camstack-server-change` §3.

## 0. Preflights — every time

**Push first.** `gh workflow run --ref main` builds `origin/main`, not your
tree. A commit only on your machine is silently absent from the publish:

```bash
git log --oneline origin/main..HEAD    # MUST be empty before triggering
```

**Check the changelogs exactly as CI will.** The job's first gate refuses
any package changed since the newest `publish-*` tag ON ORIGIN without an
`[Unreleased]` line. The gate fetches origin's tags itself before choosing
its base; run it right before dispatching, and add the missing lines:

```bash
npx tsx scripts/check-changelog-unreleased.ts      # must print ✔
npm run changelog:add -- <package> "<operator line>" --type changed
```

Two ways a line goes missing unseen: a changelog hunk cherry-picked across a
publish lands under the released version instead of `[Unreleased]` (read the
head of the file), and a bundle that changes without code (the viewer bundle
in the orchestrator — `ship-viewer.mjs` now writes that line itself).

**Sync the lockfile.** The job runs `npm ci`, which fails with `EUSAGE` /
`Missing: … from lock file` whenever a new workspace package or a dependency
bump is not in the root `package-lock.json` (the log tail is a long `npm help
ci` dump — grep for `EUSAGE`):

```bash
npm install --package-lock-only --ignore-scripts
git add package-lock.json && git commit -m "chore: sync package-lock before CI publish" && git push origin main
```

**Runners.** `ci.yml`, `checks.yml`, `publish-packages.yml` and
`unpublish-retired.yml` run on GitHub-hosted `ubuntu-latest`. The release
workflow's light jobs (`derive-version`, `create-release`, `publish-release`,
`summary`) do too. Docker and Electron stay on the home runners
(`[self-hosted, linux, x64, ci-release]` / `docker`, and
`[self-hosted, macos, arm64]`), in the org runner group `release`, which
allows only `release.yml` on `main`. Never dispatch the `Checks` workflow —
it is operator-only (D704).

## 1. Publish packages — `Publish Packages`

`workflow_dispatch` only. Inputs:

| input | default | meaning |
| --- | --- | --- |
| `bump` | `patch` | `patch` / `minor` / `major` |
| `scope` | `affected` | `affected` (changed since the last `publish-*` tag) or `all` |
| `include_dependents` | `false` | OFF = only packages whose OWN files changed. ON = the full nx-affected cascade — only for a deliberate change that must propagate to every dependent |
| `force_packages` | `""` | comma-separated extras, always published (not demoted to a bundle candidate) |
| `exact_version` | `""` | pin every selected package to one version (restart a line) |
| `dry_run` | `false` | build, print the final set and each output decision, do not bump or publish |

**Changelog gate.** Before the bump the job runs
`scripts/check-changelog-unreleased.ts` against the last `publish-*` tag: a
package whose own files changed (specs, README and CHANGELOG themselves do not
count) needs at least one line under `## [Unreleased]`, or the run fails with the
package list and the `npm run changelog:add -- <package> "<line>"` command to
run. After the bump, `scripts/release-changelog.ts` moves each published
package's entries under `## [<new version>] - <date>`; a package published with
no entries (`force_packages`, closure, bundle candidate) gets "Rebuilt against
updated dependencies." The bump commit carries the CHANGELOGs. Write the lines
before dispatching, push, then dispatch.

```bash
gh workflow run "Publish Packages" --ref main -f bump=patch -f scope=affected -f include_dependents=false
gh workflow run "Publish Packages" --ref main -f bump=patch -f scope=affected -f dry_run=true
gh run list --workflow="Publish Packages" --limit 1
gh run watch <run-id>
```

**A package the bundle cascade adds is published only when its built output
changes.** Own files, `force_packages` and `include_dependents` still publish
unconditionally, and `@camstack/server` still publishes when a closure member
does. A bundler selected only because it inlines something (admin pages
inlining `ui-library`, `system` inlining `types`) is hashed against the
registry tarball after the build. The same bytes → dropped, and the server
keeps the pin it already has. `dry_run=true` prints one line per package
(`bundle unchanged` or `dist differs: N files`) and stops before the bump.

**A capability change** (`*.cap.ts`) selects `@camstack/system` as that kind
of candidate, because system inlines the cap definitions the hub serves.
The output check publishes system when those bytes differ, and
`@camstack/server` with it. `force_packages=@camstack/system,@camstack/server`
still publishes both even when the built output matches.

The workflow bumps, builds, publishes, commits the bumps as
`chore: publish packages (patch) [skip ci]` and pushes a `publish-<ts>` tag
(the base of the next `affected` diff). A version that already exists on npm is
skipped, not failed — audit a suspicious run with `npm view <pkg> time`.

### The registry lies for a few minutes

Right after a successful run `npm view <pkg> version` still serves the
previous version and `npm install <pkg>@<new>` (so `applyServerUpdate` too)
can 404 on the tarball. Neither is a failed publish, and **neither is a reason
to publish again**. Read what the run published from its `Bump package
versions` log, then wait for the artefact:

```bash
curl -sI https://registry.npmjs.org/@camstack/server/-/server-<VER>.tgz | head -1   # 200 = installable
npm view @camstack/server@<VER> version                                            # exact version, not `version`
```

### Is the framework fix IN the server you will install?

A `types` / `system` fix is live only when a `@camstack/server` whose closure
PINS that version is installed. A server published in an earlier run
legitimately pins the older one:

```bash
npm view @camstack/server@<VER> dependencies
```

If the pin is behind, publish `force_packages=@camstack/server` once and
install that.

### Verify the CONTENT, not the version

```bash
cd "$(mktemp -d)" && npm pack @camstack/<pkg>@<VER> && tar -xzf *.tgz
find package/dist \( -name '*.js' -o -name '*.mjs' \) -exec grep -l '<string from the change body>' {} \;
```

Pick a literal from the BODY of the change (a message, an enum member) — a
minifier renames symbols — and check runtime `.js`, not only `.d.ts`.

## 2. Cut a release — `Release — CamStack (Docker + Electron)`

`workflow_dispatch` from `main` only. The first job refuses any other ref.
`publish_release=true` is the release: image, desktop installers and a GitHub
release. `false` (the default) builds artifacts only — installers stay on the
home runner, no tag, no GitHub release. Other inputs: `version_type` (artifact
runs only; a publish ignores it), `multi_arch`, `skip_docker`,
`electron_platforms` (artifact runs only), `dry_run`.

`vX.Y.Z` is the **product** version (image, desktop app, GitHub release),
starting at 0.1.0 beta (D943). It is not `@camstack/server`. Commit the same
number in `product-version.json` and `packages/desktop/package.json` on
`main`. The workflow creates `v<version>` on the dispatched commit and refuses
when that tag already exists. npm packages stay on 1.2.x. The viewer app stays
on 1.0.x.

```bash
gh workflow run "Release — CamStack (Docker + Electron)" --ref main -f publish_release=true
gh run list --workflow="Release — CamStack (Docker + Electron)" --limit 2
```

Dry run — derive only, nothing published:

```bash
gh workflow run "Release — CamStack (Docker + Electron)" --ref main \
  -f dry_run=true -f version_type=patch
```

**The product version does not have to exist on npm.** `derive-version`
resolves `@camstack/server` dist-tag `latest` and records that closure
(`scripts/ci/verify-release-npm.mjs`). It fails when `latest` cannot be
resolved, not when `latest` differs from the product version. The image and
the desktop app both install `@latest`. A 1.2.x desktop install will not
auto-update to 0.1.0 — reinstall once (D943). Dispatch only after that
publish has landed.

Docker and Electron run on the home runners (group `release`). A leg sitting
in `queued` is an offline home runner. Cancel a publish that has not finished;
if `create-release` already made the tag, delete it before dispatching again,
or a later push of `intel-latest` comes from the older tree.

## 3. Retiring a published package

npm refuses a whole-package unpublish once the first publish is more than 72 h
old (`422`). Unpublish only versions under 72 h, and `npm deprecate <pkg>
"<message>"` the rest. Long form: `docs/architecture/update-and-release.md`
§"Retiring a published package".

## Quick reference

| Want to ship… | Do | Then |
| --- | --- | --- |
| changed packages | `Publish Packages`, `include_dependents=false` | `applyServerUpdate` per node (framework) / `camstack deploy` (addon) |
| a capability change | the same + `force_packages=@camstack/system,@camstack/server` | `applyServerUpdate` per node, then deploy the providing addon |
| a release (image + desktop app) | publish → wait for npm → commit the product version on `main` → `gh workflow run "Release — CamStack (Docker + Electron)" --ref main -f publish_release=true` | the workflow creates `vX.Y.Z`; nodes still need `applyServerUpdate`; an image only changes on a container recreate |

## Done-gate — paste it before "done"

```
PUBLISH DONE — <what>
preflight:  origin/main..HEAD empty; lockfile in sync
publish:    run <id> — published <pkg → version, from the run log>
registry:   <tarball 200 for the versions that matter>
pins:       @camstack/server@<VER> pins system/types <versions>
release:    <publish_release dispatch — run <id>, tag vX.Y.Z on <sha> | not released>
next:       <applyServerUpdate / camstack deploy still to do, or done — camstack-server-change gate>
```
