---
id: D974
title: The public MCP ships inside the CLI as toolsets, and every write is preview then confirm
status: accepted
date: 2026-10-30
supersedes:
applies-to:
  - packages/cli/src/mcp/**
  - packages/cli/src/commands/mcp.ts
  - packages/develop/src/mcp/**
  - packages/mcp-develop/src/**
---

## Context

Operators and plugin authors want an assistant that can install, inspect and
configure Dominevo. The existing MCPs do not fit: `camstack-dev` and
`camstack-ops` are private to this repository, and `@dominevo/mcp-develop` is a
separate package with its own hub environment variables (token in the
environment, against D783). A second public package would need its own
credential story and its own release.

## Decision

The public MCP is the command `dominevo mcp` of the `camstack` CLI
(`npm i -g dominevo`, then `claude mcp add camstack -- dominevo mcp`), a stdio
server whose tools are grouped in toolsets chosen with `--toolsets`:
`setup`, `ops`, `configure` (the default) and `develop` (opt-in; the tools of
`@dominevo/mcp-develop`, imported, not copied).

- **Auth is the CLI's own chain**: `--token-file`, then the `dominevo login`
  session, refreshed automatically. No token in the environment, and the MCP
  never accepts a password. A tool that needs a hub and finds no session
  answers with a structured `no-session` result naming
  `dominevo login <host>`, never a throw.
- **Hub-less `setup` tools need no credentials**; their only network is the
  public npm registry.
- **Every `configure` tool is two-step through the D836 gate**: a call without
  `confirm_token` is a dry run that changes nothing and returns a one-shot
  token bound to the tool and the exact arguments; the call with the token
  applies it. Public mode has no `--allow-mutations`: the gate is always armed.
- **Issue and PR drafts** (later phases) are opened only through the user's own
  `gh` after the same confirm step; the MCP holds no GitHub credential.
- The shared pieces (query gate, mutation gate, secret scrubbing, output
  redaction, the hub connection) live in `@dominevo/develop`; the private MCP
  imports them from there. One copy.

## Consequences

The CLI gains the MCP SDK and `zod` as dependencies (loaded lazily, only by
`dominevo mcp`). `@dominevo/mcp-develop` is a deprecated alias for one
release. Every future write tool must be written as a `GatedToolSpec` whose dry
run only reads.

## Enforcement

Specs in `packages/develop/src/mcp/__tests__` (gate binds tool and arguments,
token single-use) and `packages/cli/src/__tests__/mcp-server.spec.ts`
(toolset selection, no-session result, a write never happens without a matching
token). Nothing else checks it; review only for new tools.
