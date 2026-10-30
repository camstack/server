---
id: D978
title: ESPHome is one integration holding several boards, each board secret keyed by its row id
status: accepted
date: 2026-10-30
supersedes: D952 (one broker per board)
applies-to:
  - packages/addon-provider-esphome/**
---

## Context

D952 gave each ESPHome board its own broker record, so two dozen boards meant two
dozen integrations to add, edit and delete. The operator wants ONE ESPHome
integration that holds all of its boards.

## Decision

The integration config is a list `boards: { id, host, port, name?, encryptionKey,
password? }[]`. The addon keeps one native connection per row and each board stays
its own Container device with entity children. Adding or removing a row connects or
disconnects only that board (the owner saves with `skipRestart` and reconciles in
process, so no respawn drops the other boards). `encryptionKey` and `password` are
keychain secrets addressed per row, `boards[<rowId>].encryptionKey`. Existing broker
records migrate to a one-entry list: write, read back, verify, then delete the old
record; a redacted placeholder is never copied. `addBoardToIntegration` is the one
internal function a discovery worker calls to add a board.

## Consequences

`secretKeys` on the integration door accept array-row paths; `integrations.setSettings`
gains an owner-only `skipRestart`. The `broker` capability and `brokerKind` leave the
manifest (`mode: "account"`).

## Enforcement

`esphome-integration-boards.spec.ts` (migration marks a field and asserts it survives),
`integration-secrets.spec.ts`, `check-secret-fields-declared`.
