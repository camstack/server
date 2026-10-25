#!/usr/bin/env python3
"""How many threads an embedding engine's onnxruntime session may hold.

Both embedding subprocesses — `raw_tensor_inference.py` and
`text_encoder_inference.py` — build an `ort.InferenceSession` with no
`SessionOptions`, so onnxruntime takes `intra_op_num_threads` = the HOST's core
count. These are not one-shot scripts: each writes a READY frame and then sits
in a `while True` serving requests, so those threads are held for the life of
the process. On this cluster's hub that is 20 threads per engine, and it grows
with the machine — a fact about the host, not about the work.

The sibling `yamnet_audio.py` already learned this the expensive way
(~1000% CPU across a handful of audio streams) and caps to one op thread with a
`--threads` override. This is the same rule, made testable: the caller states a
ceiling, the machine's core count caps it, and the result is never zero.

Kept free of numpy and onnxruntime on purpose — neither installs on the
operator's Mac, and a decision worth testing should not need a GPU runtime to
be checked.
"""
from __future__ import annotations

import unittest

from session_threads import resolve_session_threads


class TestResolveSessionThreads(unittest.TestCase):
    def test_a_request_larger_than_the_machine_is_capped_by_the_machine(self) -> None:
        intra, _ = resolve_session_threads(8, cpu_count=4)
        self.assertEqual(intra, 4)

    def test_a_smaller_request_is_honoured_on_a_big_host(self) -> None:
        # The whole point: a 20-core hub must not hand 20 permanent threads to
        # an engine that asked for 4.
        intra, _ = resolve_session_threads(4, cpu_count=20)
        self.assertEqual(intra, 4)

    def test_it_never_resolves_to_zero_or_fewer_threads(self) -> None:
        for requested in (0, -3):
            with self.subTest(requested=requested):
                intra, inter = resolve_session_threads(requested, cpu_count=20)
                self.assertEqual(intra, 1)
                self.assertGreaterEqual(inter, 1)

    def test_an_unknown_core_count_does_not_silently_become_no_threads(self) -> None:
        # os.cpu_count() returns None when it cannot tell. Folding that into 0
        # would hand onnxruntime an invalid session; the request stands instead.
        for unknown in (None, 0):
            with self.subTest(cpu_count=unknown):
                intra, _ = resolve_session_threads(4, cpu_count=unknown)
                self.assertEqual(intra, 4)

    def test_inter_op_is_always_one(self) -> None:
        # These engines serve ONE request at a time by construction (a framed
        # read, an inference, a framed write). There is never a second graph
        # branch in flight for inter-op parallelism to run.
        for cpu in (1, 4, 20, 64):
            with self.subTest(cpu_count=cpu):
                _, inter = resolve_session_threads(4, cpu_count=cpu)
                self.assertEqual(inter, 1)


if __name__ == "__main__":
    unittest.main()
