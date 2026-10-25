# CamStack developer skill pack

Portable markdown procedures for humans and AI agents authoring CamStack
addons. Same checklist as the server-repo Claude/Cursor skills, sanitized for
third-party use (no private hostnames, no hub-specific ops).

| Skill | File | Job |
| --- | --- | --- |
| `camstack-addon` | [camstack-addon.md](./camstack-addon.md) | New or extended addon |
| `camstack-capability` | [camstack-capability.md](./camstack-capability.md) | New or changed `*.cap.ts` |
| `camstack-secrets` | [camstack-secrets.md](./camstack-secrets.md) | Password / token / key fields |
| `camstack-docs` | [camstack-docs.md](./camstack-docs.md) | Generated vs prose docs |
| `architecture` | [architecture.md](./architecture.md) | Plugin-author architecture pointers |
| `track-review` | [track-review.md](./track-review.md) | Find wrong-class tracks, curate the re-training set (`track_review_*` MCP tools) |

These files are the canonical public text. In the server repository the
matching `.claude/skills/<id>/SKILL.md` is an overlay that points here and keeps
only repository rules (`scripts/check-skill-pack-sync.ts` enforces it, D837).
The ids match the server repository's `.claude/skills/<id>/` skills (renamed
on 2026-10-09); the old ids `add-addon`, `add-capability` and `sync-docs` still
resolve as aliases.

## How to use

### CLI

```bash
# From a camstack-server checkout:
camstack develop skills
camstack develop skill camstack-addon

# Scaffold / validate with the same tooling agents should call:
camstack develop scaffold addon my-feature --kind provider
camstack develop find-example notifier
camstack develop validate my-feature
```

### MCP

```bash
npx @camstack/mcp-develop
# or: node packages/mcp-develop/dist/server.js
```

Tools wrap the same `@camstack/develop` operations (`list_addons`,
`scaffold_addon`, `validate_addon`, `find_example`, `get_skill`, …). The
`track_review_*` tools additionally talk to a hub — see the `track-review` skill
for the environment variables and the confirm-before-write rule.

### Agents

Point the agent at this directory (or load individual `.md` files) at session
start. Prefer CLI/MCP tools over improvising wiring.

Published with `@camstack/develop` (`skills/` in the package `files` list).
Public docs: [Develop → MCP and skills](https://docs.camstack.com/docs/develop/mcp-and-skills).
