#!/usr/bin/env python3
"""The thread ceiling for an embedding engine's onnxruntime session.

Deliberately free of third-party imports so the decision can be tested without
onnxruntime or numpy installed — see `test_session_threads.py` for why that
matters and what this prevents.
"""
from __future__ import annotations


def resolve_session_threads(
    requested: int, cpu_count: int | None
) -> tuple[int, int]:
    """(intra_op_num_threads, inter_op_num_threads) for an engine session.

    `requested` is a CEILING the caller states, not a tuning: it exists so the
    permanent thread cost of a long-lived engine stops scaling with whatever
    host it lands on. The machine's own core count caps it in turn, because
    asking for more op threads than there are cores only buys coordination.

    An unknown core count (`os.cpu_count()` answers None when it cannot tell)
    means "no cap available", NOT "no cores": the request stands. Folding an
    unreadable measurement into zero is the mistake D393 names.

    inter-op is always 1. Both engines serve exactly one request at a time by
    construction — read a framed request, infer, write a framed response — so
    there is never a second branch of the graph in flight for inter-op
    parallelism to run.
    """
    ceiling = max(1, requested)
    if cpu_count is not None and cpu_count > 0:
        ceiling = min(ceiling, cpu_count)
    return ceiling, 1
