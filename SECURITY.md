# Security

CamStack 0.1 is a beta. Supported releases are **0.1.x** (the product version
on the hub, labelled beta while the major is 0).

## Reporting

Report a vulnerability in private. Do not open a public GitHub issue, pull
request, or Discussion for it.

- E-mail: ruoccogianluca1@gmail.com
- GitHub private vulnerability reporting:
  <https://github.com/camstack/server/security/advisories/new>
  (use this once the repository has the feature enabled)

## What to include

- The product version (`0.1.x` from the hub) and, if you have it, the
  `@camstack/server` version or image tag
- How the hub is installed (Docker, Unraid, Proxmox, desktop) and whether the
  node is a hub or an agent
- What an attacker can do, and whether the hub is reachable from the internet
- Steps or a request that shows the problem

Leave out secrets, tokens, private keys, LAN addresses, and camera images or
video unless they are required to understand the bug. If they are, say so and
send them only in the private report.

## What to expect

Reports are read as time allows. There is no response-time promise and no
bounty. Please allow a reasonable window before any public write-up.

## Scope

In scope:

- This server repository (the hub, agents, and the addons it ships)
- Addons installed on a hub, including an addon published on its own
- The public viewer site at <https://camstack.zentik.app>
- The Alexa skill Lambda template in `packages/addon-export-alexa/lambda-template`

A camera, notifier, or other integration you configured is in scope only where
CamStack's own code mishandles it. A vulnerability in that other service is not.
