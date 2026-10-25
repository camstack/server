# Contributing

Pull requests are accepted. GitHub Issues and Discussions are open on
[camstack/server](https://github.com/camstack/server).

A vulnerability is not an issue. Report it as [SECURITY.md](SECURITY.md)
describes. Questions belong in
[Discussions](https://github.com/camstack/server/discussions).

User guides: <https://camstack-docs.zentik.app>

## Build and run

Node.js 24 or newer, from a checkout of this repository:

```bash
npm run dev:full    # watch packages, the server, and the admin UI
npm run test        # package tests
npm run verify:push # the gate before a push: TypeScript against the pins, and affected tests
```

`npm run serve -w server/backend` runs the server alone. The admin UI is the
browser on the hub (port 4443).

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`,
`fix:`, `docs:`, `refactor:`, `test:`, `chore:`. Write the message in English.
Say why the change exists.

## Guards and generated docs

A `*.cap.ts` change is not done until codegen has been run. Codegen writes the
capability routers and the generated types:

```bash
npm run codegen
npm run docs:check
```

`docs/reference/*` is generated. Do not hand-edit it; the docs check fails
when it has drifted.

`scripts/check-*.ts` are the repository guards. They refuse, among other
things, private data (addresses, host names, tokens) and a competing product's
name where the text should name the mechanism. Run the guard you touched
(`npx tsx scripts/check-<name>.ts`). Do not put secrets, house addresses, or
camera media in a commit, an issue, or a pull request.

## Extending CamStack with the developer MCP

Two MCP servers exist. They are not the same package.

### Plugin authors — `@camstack/develop` and `@camstack/mcp-develop`

`@camstack/develop` is the catalogue, scaffold, and validator. The CLI is
`camstack develop` (from `@camstack/cli` in this repository). The same
operations are the MCP server `@camstack/mcp-develop`:

```bash
npx @camstack/mcp-develop
```

```json
{
  "mcpServers": {
    "camstack-develop": {
      "command": "npx",
      "args": ["@camstack/mcp-develop"]
    }
  }
}
```

`camstack develop` only runs inside a checkout of this repository. It walks
up to a workspace whose `package.json` lists `packages/*`. These commands
are the ones the CLI actually implements:

```bash
camstack develop list-addons
camstack develop list-caps
camstack develop who-provides <cap>
camstack develop examples
camstack develop find-example <query>
camstack develop scaffold addon <name> --kind empty|provider|notifier|osd|post-analysis
camstack develop scaffold cap <name> --scope system|device --mode singleton|collection
camstack develop extend <addon> --entry <id>
camstack develop validate [addon]
camstack develop skills
camstack develop skill <id>
```

`scaffold addon` writes `packages/addon-<name>/`. `validate` checks the
manifest, that each `entry` has a source file and a matching vite entries
key, and that a capability declared as `{ "name": "..." }` exists in this
workspace. A string in `capabilities` is not checked by that pass. The CLI and `@camstack/mcp-develop` write unless you pass
`--dry-run` or `dryRun: true`. The private `@camstack/mcp-dev` tool is the
other way around: `scaffold_addon` is a dry run unless `dryRun: false`.

Tools on `@camstack/mcp-develop` (workspace only, no hub):

| Tool | What it does |
| --- | --- |
| `list_addons` | Packages in the workspace that declare `camstack.addons[]` |
| `get_addon` | One package by id, npm name, or path |
| `list_capabilities` | Capability names from `packages/types` `*.cap.ts` sources |
| `get_capability` | One capability by name |
| `who_provides` | Which addons declare a capability |
| `list_examples` | The curated example catalogue |
| `find_example` | Rank those examples for a free-text query |
| `validate_addon` | Manifest, vite entries, and known capability names |
| `scaffold_addon` | New `packages/addon-<name>/` |
| `scaffold_cap_stub` | A `*.cap.ts` stub. It does not edit the barrel or run codegen |
| `extend_addon` | Another manifest entry in a package that already exists |
| `list_skills` / `get_skill` | The portable skill pack |

`track_review_*` on the same server talk to a hub (triage and curate tracks
for training). They are separate from scaffolding. The `track-review` skill
describes the environment variables and the confirm-before-write rule.

The skill pack ships in `@camstack/develop` (`skills/`). The ids are
`camstack-addon`, `camstack-capability`, `camstack-secrets`, `camstack-docs`,
`architecture`, and `track-review`. The page the pack links is
[Develop → MCP and skills](https://docs.camstack.com/docs/develop/mcp-and-skills).

### This repository — `@camstack/mcp-dev` (not published)

`packages/mcp-dev` (`camstack-dev`) is the operator MCP for developing
CamStack itself. `package.json` marks it `private`. It is not on npm. It wraps
the same `@camstack/develop` addon tools and adds the workspace knowledge
tools: `search_knowledge`, `get_decision`, `decisions_for_path`, `traps_for`,
`guards_for`, `subsystem_of`, `subsystem_map`, `read_section`,
`next_adr_number`, `list_skills`, `get_skill`, `find_ui_component`,
`get_ui_component`, `list_ui_tokens`, `scaffold_ui_component`, `check_ui_file`,
`plan_capability`, `scaffold_capability`, `run_codegen`, `method_tiers_diff`,
`cap_ship_plan`, `affected_checks`, `run_checks`, `release_plan`,
`release_status`.

`scaffold_capability` and `plan_capability` exist on this private server.
The published server's capability stub is `scaffold_cap_stub`.

### What you can add

| Kind | Where to look |
| --- | --- |
| Device provider | `packages/addon-provider-rtsp` (small), `packages/addon-provider-onvif`, `packages/addon-provider-hikvision`, `packages/addon-provider-reolink`, `packages/addon-provider-homeassistant` |
| Notifier | `packages/addon-notifiers`, `packages/addon-smtp-nodemailer` (one collection provider and a settings form) |
| Storage or log destination | `packages/addon-remote-storage` (S3, WebDAV, SFTP, SMB). The log destination `loki-logging` is a builtin in `packages/system` |
| Pipeline step or detector | `packages/addon-pipeline` (`detection-pipeline`, `motion-wasm`, `audio-analyzer`, `recorder`), `packages/addon-decoder-nodeav`, `packages/addon-post-analysis` |
| Capability | `packages/types/src/capabilities/*.cap.ts`. Behavioural metadata (`kind`, `defaultActive`, `mode`) lives only in that file. The manifest names the capability |
| Admin page or widget | `packages/addon-osd-manager`, `packages/addon-model-studio`, `packages/addon-benchmark`, `packages/addon-training` |
| Viewer | The viewer app is its own repository. In this tree, `viewer-ui` is a capability on `packages/addon-pipeline-orchestrator` |

A runnable addon on its own, a bundle, tests, and a full `package.json` are
in [camstack/addon-examples](https://github.com/camstack/addon-examples) and
on the docs page
[/docs/developers/addon-examples](https://camstack-docs.zentik.app/docs/developers/addon-examples).

One addon is one process. An addon does not import another addon; it calls
`ctx.api`. A credential is a `password` field on the settings schema, not an
environment variable. Log with the logger on `ctx` (no `console.log`). Emit
with `ctx.eventBus`. A class that `extends BaseAddon` declares a constructor
and calls `super(...)`. Without that call, `BaseAddon` is constructed with
`undefined` and the addon fails to initialise on the node
(`scripts/check-addon-calls-super.ts`).

## Publishing your own addon to npm

An addon can live in its own repository, be published to npm, and be installed
on a hub without a change to this repository.

### How a hub finds it and installs it

Discovery is an npm keyword search, not a name prefix. The hub requests:

`https://registry.npmjs.org/-/v1/search?text=keywords:camstack+keywords:addon&size=250`

So the package's `keywords` must include both `camstack` and `addon`. The
scaffold also writes `camstack-addon`; that third keyword is not what the
search query requires. The Addons page search box then filters that result by
package name, description, or keyword. It does not look up an arbitrary name
that failed the keyword search.

Install is explicit. Choosing the package calls `addons.installPackage` with
`{ packageName }` and no version. The installer resolves the dist-tag
`latest`, downloads the tarball, and refuses it when `package.json` has no
`camstack.addons` array (`Package <name> has no camstack.addons manifest`).
The name may be scoped (`@scope/addon-name`) or unscoped. Nothing in that
path requires the `@camstack/` scope or a `camstack-addon-*` prefix. The
scaffold's own name is `@camstack/addon-<name>`.

A `.tgz` upload on the same page is the other way in. It has the same
manifest requirement.

`validate_addon` is stricter than the installer: an empty `camstack.addons`
is an error, a missing description is a warning, and each `entry` must have
a source file and a matching vite entries key.

### Names, tags, and versions

Versions are semver. Hubs follow the dist-tag `latest`. The auto-update
channel is `off`, `latest`, or `beta`:

- `latest` moves the installed copy to dist-tag `latest`, including when that
  version is lower than what is installed
- `beta` prefers dist-tag `beta`, then `latest`
- `off` does not apply the sweep
- `next` is not read by that sweep. Passing version `next` (or `beta`) to an
  install resolves that dist-tag by name; a missing tag does not remove the
  installed copy

An agent does not ask npm. It installs the version the hub already has.

### Layout

`camstack develop scaffold addon <name>` (and MCP `scaffold_addon`) writes
this inside a checkout of this repository. It refuses to run outside one.
The `vite.config.ts` it writes imports `../../tools/build/vite-lib.preset.ts`,
which exists only in this repository. A package in its own repository keeps
the same manifest and class shape; the full file set that builds on its own
is the [addon-examples](https://github.com/camstack/addon-examples) repository.

The scaffold's `package.json` is:

```json
{
  "name": "@camstack/addon-my-feature",
  "version": "0.1.0",
  "keywords": ["camstack", "addon", "camstack-addon"],
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "files": ["dist"],
  "camstack": {
    "displayName": "My Feature",
    "addons": [
      {
        "id": "my-feature",
        "name": "My Feature",
        "description": "My Feature — CamStack addon.",
        "entry": "./dist/my-feature.addon.js",
        "execution": { "placement": "hub-only" },
        "capabilities": []
      }
    ]
  },
  "peerDependencies": { "@camstack/types": "*" },
  "scripts": { "build": "vite build" }
}
```

`placement` is `hub-only` (the default when `execution` is omitted),
`agent-only`, or `any-node`.

The class the scaffold writes extends `BaseAddon` and calls
`super({ ...DEFAULTS })` from its constructor. Build with vite so `entry`
points at a file under `dist/`. `files` is `["dist"]` so the published
tarball contains the bundle and `package.json`.

`externals: 'self-contained'` (what the scaffold sets) inlines
`@camstack/types`, `@camstack/sdk`, `zod`, and `@trpc/*`. It leaves
`@camstack/system` and `@camstack/ui-library` out of the bundle. For that
mode the host that actually has to resolve an import is `@camstack/system`
(`packages/system/src/kernel/host-externals.ts`). Native modules the preset
also keeps external are `sharp`, `node-av`, `node-pty`, and `ssh2`. Do not
import `ALL_CAPABILITY_DEFINITIONS`. The lightweight types entry is
`@camstack/types/addon`.

The record that lists `@camstack/sdk` and `@camstack/types` subpaths as
host-external describes `framework` externals. The scaffold does not emit
`framework`; it emits `self-contained`, which inlines those packages. The
scaffold's `peerDependencies` still names `@camstack/types` only.

### Before you publish

From this repository, after the scaffold:

```bash
camstack develop validate my-feature
npm run build -w @camstack/addon-my-feature
camstack deploy packages/addon-my-feature
```

`validate_addon` should report no errors before `npm publish`. From the
addon directory, `camstack deploy` (path defaults to `.`) packs that
directory and installs it on the hub you are logged in to, so you can try
the build before the registry has it. Publish with `npm publish`. After
`latest` moves, a hub whose channel is `latest` installs that version.

Models in this repository, knowing they use the monorepo preset:
`packages/addon-smtp-nodemailer`, `packages/addon-provider-rtsp`, and
`packages/addon-remote-storage`. The standalone runnable copy is
[addon-examples](https://github.com/camstack/addon-examples).
