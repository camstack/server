# CamStack CLI

CLI tool for managing and running CamStack server.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `camstack` on npm.

## Requirements

- Node.js >=24.

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->

## MCP: doctor, token files, restarts

- `camstack mcp doctor` is a read-only check of Node (>= 24), the hub, its pinned CA, the session or token file, the token scope (admin or not) and the CLI version against npm. Each line is ok / fail / unknown with a fix hint, and no token is ever printed.
- `camstack login <host> --token-file <path>` logs in without a TTY: the token comes from a file only you can read (`chmod 600`; a looser file is refused), is checked against the hub and cached like the interactive login. A token is never accepted through argv or the environment.
- MCP clients such as OpenCode keep running the old `camstack mcp` process: restart them after the CLI updates.
