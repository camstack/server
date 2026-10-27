# Terminal

Interactive terminal sessions (pty + xterm) as a CamStack addon.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-terminal` on npm.

## What it provides

- **Terminal** (`terminal`): Interactive terminal sessions on any cluster node. Operators explicitly create virtual-camera instances from administrator-configured profile templates. Category: system.
  - Capabilities: `terminal-session`.

## Requirements

- Placement: any-node.
- Python: Terminal installs `python/requirements.txt` into its own environment.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/terminal.md](https://github.com/camstack/server/blob/main/docs/architecture/terminal.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
