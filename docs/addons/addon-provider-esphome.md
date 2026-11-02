---
title: addon-provider-esphome — package notes
covers:
  - packages/addon-provider-esphome/**
---

# addon-provider-esphome — package notes

## Importing board encryption keys

An integration holds a list of boards; each row carries the board's API
encryption key (a keychain secret, D978). Instead of copying keys by hand, the
integration form has an **Import keys** button (the `importBoardKeys` custom
action, admin only). It reads each board's key from a `board-key-source`
(today: the ESPHome Builder through Home Assistant, see
[addon-provider-homeassistant](addon-provider-homeassistant.md)) and stores it
through `EspIntegrationBoards.setBoardKey`, which restarts only that board's
session.

- A board is matched to a Builder board by its name, by the first label of its
  host, or by the address the Builder knows.
- Every board gets one outcome in the summary: `imported`, `unchanged` or
  `not-imported` with a reason.
- A failed read never writes, so a key a board already has is never cleared
  (D49). The key is never logged or returned.

| Reason | Meaning |
| --- | --- |
| `no-source` | no Home Assistant broker offers keys |
| `no-match` | the Builder has no board with this name, host or address |
| `ambiguous` | two Builder boards match; rename one |
| `store-failed` | the key was read but saving the row failed |
| `not-admin` | the Home Assistant token is not an administrator |
| `no-builder` | no ESPHome Builder add-on is announced in Home Assistant |
| `no-ingress-url` | the add-on exposes no ingress, or the broker has no address (supervisor token) |
| `unreachable` | Home Assistant or the Builder did not answer |
| `unknown-board` | the Builder no longer has that configuration |
| `no-encryption-key` | the board's YAML has no `api: encryption: key:` |
| `unreadable-config` | the Builder answered something that is not a config |

Why not read the Builder's own port: [D1001](../decisions/adr-1001-esphome-board-keys-are-read-through-ha-ingress-never-a-lan-port.md).
