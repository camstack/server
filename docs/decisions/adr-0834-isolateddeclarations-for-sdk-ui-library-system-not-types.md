---
id: D834
title: isolatedDeclarations for sdk, ui-library, system; not @camstack/types
status: accepted
date: 2026-10-13
supersedes:
applies-to:
  - packages/sdk/**
  - packages/ui-library/**
  - packages/system/**
  - packages/types/**
---

## Context

The `.d.ts` emit of the framework packages needs to run without the TypeScript 6
JS API and without building a whole program per package. `isolatedDeclarations`
lets each file's declarations be emitted on its own (`oxc-transform`, via
`scripts/emit-isolated-dts.ts`), which removes the heaviest emit tasks. Debt
measured in the plan: sdk 24 errors, ui-library 212, system cleared on
`tsconfig.dts.json`; `@camstack/types` has 11 809, because its exports are
Zod-inferred types by design (`z.infer<>` is the rule, not an annotation).

## Decision

The exported API of `@camstack/sdk`, `@camstack/ui-library` and
`@camstack/system` carries explicit types so `isolatedDeclarations` holds (for
system, on `tsconfig.dts.json` only; specs stay off the flag). `@camstack/types`
is exempt and keeps its Zod-inferred exports; its declarations are emitted by
the TypeScript 7 compiler.

## Consequences

- New exports in the three packages need an explicit return or value type; an
  inferred one fails the declaration build.
- Annotating `@camstack/types` is not a goal and must not be done to satisfy
  the flag: it would duplicate every schema shape the rules forbid duplicating.

## Enforcement

The `.d.ts` build of each of the three packages fails on a violation.
