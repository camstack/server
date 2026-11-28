# AI

AI addon for Dominevo — the `llm` collection provider (cloud, LAN, and camstack-managed local llama.cpp profiles) plus the per-node `llm-runtime` managed executor.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@dominevo/addon-ai` on npm.

## What it provides

- **AI** (`ai`): LLM profiles (cloud, LAN, managed local models) + per-node managed llama.cpp runtimes. Category: analytics.
  - Capabilities: `llm`, `integration-instances`, `llm-runtime`, `node-removal-hook`.

## Requirements

- Placement: any-node (runner group `ml`).
- A Dominevo hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/addons/addon-ai.md](https://github.com/dominevo/server/blob/main/docs/addons/addon-ai.md)
- [docs/architecture/secrets-keychain.md](https://github.com/dominevo/server/blob/main/docs/architecture/secrets-keychain.md)
- [packages/addon-ai/AGENTS.md](https://github.com/dominevo/server/blob/main/packages/addon-ai/AGENTS.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
