---
id: D541
title: One worker compiles a model and the rest wait for it
status: accepted
date: 2026-09-19
supersedes:
applies-to:
  - packages/addon-pipeline/python/inference_pool.py
---

## Context

The CoreML compiled-model cache (a `.coreml-cache` dir next to the models)
was written as if one process used it. A pool is several PROCESSES, and they
are spawned together: every worker reaches the cache at the same instant,
every one of them gets the same answer, and if that answer is "miss" they all
compile the same model and then all try to replace the same directory.

Measured on the Mac agent over three hours on 2026-09-19:

```
59  CoreML: compiled-model cache HIT
55  CoreML: compiled-model cache MISS — compiled and persisted
 5  CoreML: could not persist compiled-model cache
      ([Errno 2] ... /camstack-yolov9m-320.mlmodelc/weights)
      ([Errno 2] ... /camstack-cct-s-v2-global.mlmodelc/analytics)
```

Half the loads were recompiling a model that was already on disk, and the
failures name a path INSIDE the old bundle — `shutil.rmtree` walking a
directory that a second worker is swapping out from under it with
`os.replace`. Both numbers are the same bug seen from two ends: the cache had
no single writer, so it had no reliable reader either.

The cheap-looking fix — make the persist tolerant and leave the compiles
alone — was rejected. It removes the error line and keeps the waste: N
workers still each pay a multi-second compile, which is what the operator
actually feels at every pool respawn.

## Decision

A cache MISS does not compile. It takes a **per-model** lock
(`compile_cache_lock`, an `fcntl.flock` on `<cache_root>/<stem>.lock`), and
**asks the cache again** once the lock is held — the winner has usually
finished by then, so every waiter turns its miss into a hit. Only the lock
HOLDER writes the cache; a worker that compiled without the lock serves its
model and touches nothing, because that swap is the race.

The lock is bounded and never fatal in any direction. A timeout, an unusable
lock directory, a platform without `flock`, or a holder that died mid-compile
all end the same way: compile without the cache, which is exactly what this
code did before the cache existed. A cache is an optimisation, and an
optimisation that can refuse to serve a camera is worse than every miss it
prevents.

## Consequences

- Per model, not per cache: compiling the detector must not serialise behind
  the embedder. A pool still warms several models concurrently.
- A worker can wait up to `COMPILE_CACHE_LOCK_TIMEOUT_SEC` (180 s) before
  compiling on its own. That is longer than any observed compile and shorter
  than a wedged pool.
- The persist is now single-writer, and *also* tolerant of a previous cache
  that has already vanished — that is the state a holder killed mid-swap
  leaves behind, and it is the outcome the code wanted anyway.
- Anything else that writes into `.coreml-cache` must take the same lock, or
  the single-writer property is gone and the `[Errno 2]` comes back.

## Enforcement

`packages/addon-pipeline/python/test_inference_pool_cache_lock.py`: the lock
is exclusive across real spawned processes, two models do not block each
other, a timeout yields `False` rather than hanging, an unusable lock
directory yields `False`, and the persist survives a previous cache that
vanishes mid-`rmtree` (that last one fails with the exact `[Errno 2]` above
if the tolerance is removed). No guard script — review only.
