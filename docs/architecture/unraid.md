---
title: Running on Unraid
applies-to:
  - Dockerfile
last-verified: 2026-10-09
---

# Running on Unraid

Unraid is the reference deployment. This page is for the person installing
CamStack on one, and for whoever has to keep the templates true.

There is **one** container image, `ghcr.io/camstack/camstack`, and it serves both
roles. `CAMSTACK_ROLE` picks which at boot: `hub` (the default) runs the full
server and admin UI on 4443; `agent` runs a worker that joins a hub and serves a
status dashboard on 4444. There are two templates because the two roles want
different defaults, not because there are two images.

!!! note "One step left before a stranger can install"

    As of 2026-07-26 the image is **public** and the distribution repo
    ([camstack/unraid-templates](https://github.com/camstack/unraid-templates))
    exists, so an anonymous `docker pull` works and every
    `raw.githubusercontent.com` link in a template resolves — both re-verified
    anonymously on 2026-08-26 (an anonymous GHCR token resolves the
    `intel-latest` manifest; the templates, `ca_profile.xml` and `icon.png` all
    answer 200), which is the check that matters: these links look fine to
    anyone whose browser is already authenticated, which is exactly why they
    were broken unnoticed. `camstack/server` itself stays private, and that is
    fine — nothing a template fetches lives here. Remaining: the Community
    Applications submission. See [Distributing](#distributing).

## Installing

Run the hub first. One per cluster.

1. **Docker → Add Container → Template**, paste
   `https://raw.githubusercontent.com/camstack/unraid-templates/main/templates/camstack.xml`.
2. There is no credential in the template, and none is read from the
   container's environment ([D797](../decisions/adr-0797-no-secret-reaches-a-node-through-its-environment-the-hub-keeps-its-own-in-the-keychain.md)).
   A fresh hub seeds `admin` / `changeme`; the first sign-in with `changeme`
   forces a change. To recover a forgotten password, create an empty file
   `RESET_ADMIN_PASSWORD` in the appdata folder (`/data` in the container) and
   restart: `admin` goes back to `changeme` once, and the file is deleted. The
   session signing key is generated on the first boot into the keychain
   (`/data/.keychain/`). There is no cluster secret: a worker joins by being
   paired from the hub ([D857](../decisions/adr-0857-an-agents-identity-is-its-mesh-certificate-there-is-no-cluster-secret-and-a-pairing-is-confirmed-on-both-screens.md)).
3. Point **Recordings** at a roomy array share, not the cache. Leave **Media
   root** as `/recordings` — the mapping does nothing on its own, the variable is
   what tells the server to write there.
4. Leave **Backups** mapped. `/backups` is a declared `VOLUME` like `/data` and
   `/config`, so an unmapped one becomes a fresh anonymous volume on every
   container re-create. It is where backup archives seed by default
   (`CAMSTACK_BACKUP_ROOT=/backups`), so they do not fill the appdata cache.
5. Remove the hardware mappings the machine does not have — `/dev/dri` with no
   iGPU, `/dev/accel` with no Intel NPU, `/dev/bus/usb` with no Coral.

The UI is on `https://<ip>:4443` with a certificate the hub issues from its own
local CA; to serve your own instead, upload it in **Network → Local access**
(there is no template variable for it, [D726](../decisions/adr-0726-a-nodes-certificate-is-set-only-in-the-admin-ui-and-what-the-ui-shows-is-what-the-listener-serves.md)). The first boot
**installs** the addons from npm and pulls models, so give it a few minutes; the
healthcheck allows 180 seconds before it starts complaining.

The image carries no addon tree ([D129](../decisions/adr-0129.md), 2026-08-13),
only the `@camstack/server` closure it falls back to. So the first boot needs to
reach the npm registry: without it the container still boots and logs that it
installed nothing, but comes up with **no addons** at all. That is the deliberate
trade for one version of everything per node.

To add a worker, install
`https://raw.githubusercontent.com/camstack/unraid-templates/main/templates/camstack-agent.xml`
on the other machine and set **Hub address** to the hub's IP. Use a different
appdata folder from the hub. Leaving Hub address blank is fine — set it from the agent's
dashboard on port 4444. A worker advertises itself on the network (mDNS) and is paired
from the hub: you confirm the same six digits on the hub and on the worker's page
(D857); nothing is pasted and nothing secret goes in the container's environment.

## What must be true, and why

These are the settings whose absence produces a failure that does not look like
the setting. The guard exists because every one of them was wrong at some point.

| Setting | If it is missing |
| --- | --- |
| `--pids-limit=8192` | A container cgroup counts THREADS, not processes. Against the 2048 Docker/Unraid default this hub was measured refusing 22 `clone()` calls in 45 minutes — each one a thread some subsystem needed and silently did without, surfacing only as media that stopped. The ceiling stays a ceiling rather than going unbounded, because a ceiling is what makes a thread leak visible; `native-metrics` reads `pids.current/max/events` on a heartbeat so approaching it is legible instead of fatal. |
| `CAMSTACK_MEDIA_ROOT=/recordings` | `/recordings` is mounted and never written to. Recordings go to `/data` and fill the cache. |
| `/dev/bus/usb` + `--device-cgroup-rule` | A Coral USB accelerator re-enumerates on init, so the passed-through node is not the one the delegate opens. It appears to load and sheds every frame. |
| `/config` and `/backups` mapped | The image declares both a `VOLUME` (with `/data`). Unmapped, Docker mints a fresh anonymous volume on every re-create. |
| `<Restart>unless-stopped` | The NVR does not come back after a host reboot. |
| `CAMSTACK_MOLECULER_USE_HOSTNAME=false` | Nodes advertise a container hostname no other machine can resolve, and a multi-machine cluster never forms. |

`--shm-size=2g` used to be on that list and was **removed on 2026-09-19**. It
reserved a 2 GB tmpfs for the decoder frame rings, and that subsystem left with
`@camstack/shm-ring` on 2026-07-16 — nothing constructs a segment any more. The
guard could not catch it, and that is the part worth keeping: `EXTRA_PARAM_REASONS`
exists so that no flag survives unexplained, but this flag HAD a reason on file.
The reason had simply stopped being true. A reason is only as fresh as the last
time someone checked it against the code.

## The share holding `/recordings`

The container settings above are only half of it. The **share** that `/recordings`
lands on has a setting that will stop the NVR storing media while every other
sign says it is healthy.

### Minimum free space — lower it, or lose media

Unraid gives each share a **Minimum free space** floor, stored as `shareFloor`
(in KB) in `/boot/config/shares/<name>.cfg`. When free space drops below it,
shfs refuses to **create** anything on that share.

It is **auto-derived at 10% of the pool when the share is created**. Nobody
chooses it, which is why nobody remembers setting it. On a 1.8 TiB pool that
reserves **186 GiB** — a sane default for a documents share, and the wrong one
for a recorder whose whole job is to fill a disk and prune by age.

What it looks like when it bites, from a real incident:

- **Tracks with no pictures.** Every new track had positions, a class and a
  `bestEventId`, and **zero snapshots**, for hours. The list looked normal.
- **Recording kept working.** shfs fails `create`/`mkdir` but lets writes to
  ALREADY-OPEN files continue, so segments already in progress finalised fine
  while anything needing a new directory failed. 9,244 errors over 4h26m — every
  one a `mkdir`.
- **The disk was not full.** Free space was 185.53 GiB against a floor of
  186.30 GiB: **0.78 GiB under**. `df` looks fine at a glance, and the number to
  compare it against is in a file, not on the dashboard.

So: set it low and absolutely (a few GiB), not as a percentage. Retention is what
bounds this share; the floor exists to stop a share filling the *array*, which is
not the failure mode here.

```bash
# The floor actually in force, in KB (Unraid writes it; the UI shows a rounded
# value). Compare against the pool's real free space before believing `df`.
grep shareFloor /boot/config/shares/camstack.cfg
```

Two things that make it creep back:

- **A failed backup skips retention entirely.** If the share also receives
  scheduled backups, a failed run logs `RETENTION WILL NOT BE CHECKED!` and
  prunes nothing, so each failure adds a full set and removes none. Four stale
  `-failed` sets held ~113 GiB in the incident above.
- **Margin smaller than one backup set is not margin.** Recovering to 10 GiB of
  headroom on a share that receives ~30 GiB sets means the next run re-crosses
  the floor.

The server now escalates this instead of only logging it per lost file: an
out-of-space write raises one alarm for the CONDITION (see
`packages/addon-post-analysis/src/pipeline-analytics/store/storage-pressure.ts`),
because dozens of per-item warnings a minute never said
"this camera has stopped storing media".

## Updating

Two different things update on two different schedules, and confusing them costs
time — see [update-and-release.md](update-and-release.md) for the full picture.

**The application** updates itself. The hub pulls new framework and addon
versions and pushes them to agents; the container image is only the boot loader.
An agent's app version is managed by its hub, which is why an agent container can
sit on an old image tag and still run current code.

**The image** updates through Unraid's normal *check for updates*, because both
templates track the `intel-latest` tag rather than a pinned version. You need a
new image only for something baked into it: the Node runtime, the Intel GPU and
NPU drivers, or the entrypoint. **ffmpeg is not on that list any more** — since
2026-09-19 the image installs none and every node downloads the same pinned
jellyfin-ffmpeg build instead ([D540](../decisions/adr-0540-every-node-downloads-the-same-pinned-ffmpeg.md)),
so the version is data rather than an image rebuild rolled to every machine. What
the image cannot delegate is the DRIVERS, and those stay: measured 2026-09-19, the
portable build encodes VAAPI inside this container and ABORTS on the bare host
where `libva-drm.so.2` does not exist. Expect *check for updates* to offer one
often anyway — every `v*` tag builds and pushes an image, and `intel-latest`
moves with each one, whether or not anything baked in changed.

**The template does not update at all**, and this is the fact to design around.
Unraid's merge of upstream template changes into an already-installed container
is disabled in the shipping code — `DockerClient::updateUserTemplate()` opens
with `// Don't update templates` and returns immediately. A user's template is a
frozen snapshot taken at install time. "Previous Apps" and Edit deliberately
re-read that saved copy rather than the feed, and installing again from Community
Applications does not overwrite it: it appends `-1` and creates a *second*
container.

So a template fix reaches **new installs only**. A change that existing users
must adopt — a new required variable, a renamed path — has to be handled inside
the image, or announced, and cannot be pushed. Prefer making the image tolerate
the old template over changing the template.

## Distributing

Unraid has two distribution mechanisms and only one of them fits.

A **`.plg` plugin** — the thing installed from *Plugins → Install Plugin* — is
for host-side services and web-GUI pages. Community Applications' data model has
no "plugin that provides Docker apps": a feed entry is either a container, keyed
on `<Repository>`, or a plugin, keyed on `<PluginURL>`. A plugin can therefore
never appear in the Apps search as an installable container, which is the whole
point of shipping a template. A `.plg` *can* drop XML into
`/boot/config/plugins/dockerMan/templates-user/`, and essentially nobody does:
a search across every public `.plg` on GitHub finds one project doing it, and it
is a template-authoring tool, not an app. So: **a CA template repository, not a
plugin.**

CA reads templates from a public GitHub repository that the author registers
once. That repository, `camstack/unraid-templates`, is the only copy of the
templates ([D717](../decisions/adr-0717-the-unraid-templates-and-the-compose-example-are-maintained-outside-this-repo.md)):

```
camstack/unraid-templates/
  ca_profile.xml          repo manifest — must be at the ROOT, <Profile> mandatory
  icon.png                copied here so the icon is publicly fetchable
  templates/
    camstack.xml
    camstack-agent.xml
```

### One-time operator setup

Nothing below can be automated from here, and until all of it is done the
templates are correct but unusable by anyone outside the org.

1. ~~Create the public repo `camstack/unraid-templates`~~ — **done 2026-07-26.**
   Public, MIT, `ca_profile.xml` + `icon.png` at the root with `templates/`
   beside them, and a README stating the files are generated and must not be
   edited there.
2. ~~Make `ghcr.io/camstack/camstack` public~~ — **done 2026-07-26.** Verified
   anonymously against the registry's token endpoint, not by a browser that was
   already signed in.
3. **Submit the repo** at <https://ca.unraid.net/submit/new>: sign in with an
   Unraid account, add the repository URL, run *Validate* and *Scan*, fix
   anything it reports, then submit for moderator review. This replaced the old
   forum-PM process in June 2026.
4. **Keep it current by hand.** There is no sync job and no generator: edit the
   XML in `camstack/unraid-templates` directly whenever the container contract
   changes (D717).

`<Project>` points at <https://camstack.io> and `<Support>` at the distribution
repo's issues, because the source repo's issue tracker is private too. The guard
fails on any URL that is not under a known public base, which is the check that
would have caught the 404s it was written for.

## Keeping the templates true

`templates/camstack.xml` and `templates/camstack-agent.xml` in
`camstack/unraid-templates` are maintained by hand, and so is the Docker Compose
example in the public docs. Nothing in this repo checks either of them
([D717](../decisions/adr-0717-the-unraid-templates-and-the-compose-example-are-maintained-outside-this-repo.md);
the generator of D22 and D23 is gone). A change to the container contract — an
environment variable the code reads, a port it binds, a volume, a device —
updates both in the same piece of work.

One more thing to keep in mind: the `templates-user` XML on a live Unraid box
may still contain that install's real admin password and JWT secret, if it
was created before D797 removed those fields — delete them from it. It is
**not** a backup of the repository copy and must never be pasted back into one.
