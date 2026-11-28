"""The trainer's one failure type and its exit codes."""
from __future__ import annotations

#: Process exit codes the hub reads.
EXIT_OK = 0
EXIT_BAD_SPEC = 64
EXIT_DATASET = 65
EXIT_INTERNAL = 70


class TrainerError(Exception):
    """A failure with a stage, a stable code and an exit code.

    ``message`` is shown to the operator: it never names a frame path or a
    camera, only counts and codes.
    """

    def __init__(self, stage: str, code: str, message: str, exit_code: int) -> None:
        super().__init__(message)
        self.stage = stage
        self.code = code
        self.message = message
        self.exit_code = exit_code

    def as_dict(self) -> dict[str, str]:
        return {"stage": self.stage, "code": self.code, "message": self.message}


def spec_error(code: str, message: str) -> TrainerError:
    return TrainerError("prepare", code, message, EXIT_BAD_SPEC)


def dataset_error(code: str, message: str) -> TrainerError:
    return TrainerError("prepare", code, message, EXIT_DATASET)
