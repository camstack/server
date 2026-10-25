---
id: D727
title: User-facing text carries no decision ids and no history prose
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - scripts/check-user-facing-decision-ids.ts
---

## Context

Decision ids are an index into `docs/decisions/`, a directory an operator never
sees. They leaked into the product anyway: the Data → Storage help text cited
two (a storage declaration's `description` in a package manifest), the Addons
page a third (an addon's manifest `description`), and error messages, settings
descriptions and a benchmark label cited more. The public documentation had the
same problem, plus sentences explaining how a page or setting used to be.

A sweep fixes the tree once; nothing about how the next help string is written
changes, so the ids came back each time the author was also the person who had
just written the ADR.

## Decision

Text an operator reads says what a thing does and what to do — never which
decision record made it so, and never how it used to be. This covers JSX text
and UI props, settings/schema `description`/`label`/`help`/`hint`, zod
`.describe()`, error messages, notification template descriptions, locale files
and package-manifest descriptions. Code comments, ADRs and `docs/` keep their
ids.

## Consequences

The "why" of a user-facing refusal lives in a code comment beside it, not in
the string. An error message that used to end in `(D540)` now ends at the
sentence; a developer follows the comment, an operator follows the sentence.

## Enforcement

`scripts/check-user-facing-decision-ids.ts` parses every non-test `.ts`/`.tsx`
under `packages/*/src` and `server/*/src` with the TypeScript compiler (so
comments, identifiers and logger calls are never judged), the locale JSON files
and every package manifest, and fails on `\bD\d{1,4}\b` / `adr-NNN`. It runs on
staged files in the pre-commit hook and over the tree in the Checks workflow.
The viewer's `ts-check` runs a matching guard over its locales and JSX, and the
public docs site refuses to build with an id or a history phrase in its content.
