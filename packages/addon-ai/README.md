# @camstack/addon-ai

AI addon for CamStack — the `llm` collection provider (cloud, LAN, and camstack-managed local llama.cpp profiles) plus the per-node `llm-runtime` managed executor.

## What it does

- **AI** (`ai`): LLM profiles (cloud, LAN, managed local models) + per-node managed llama.cpp runtimes
  - Node placement: `any-node`, runner group `ml`.
  - Capabilities: `llm`, `llm-runtime`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

