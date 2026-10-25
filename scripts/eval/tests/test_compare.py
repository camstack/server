"""Baseline vs candidate on a holdout: both measured on the same frames, the
candidate's floors proposed by the D739 rule, and the per-camera recall delta
that a promotion gate reads."""
from camstack_eval.compare import compare_models, select_holdout
from camstack_eval.dataset import EvalFrame
from camstack_eval.floors import FloorPolicy
from camstack_eval.metrics import Detection, FrameTruth, GroundTruthBox

BOX = (0.1, 0.1, 0.2, 0.4)
FP_BOX = (0.7, 0.7, 0.1, 0.2)


def frame(fid, camera, captured_at=0):
    truth = FrameTruth(fid, camera, False, (GroundTruthBox("person", BOX),))
    return EvalFrame(truth=truth, path=fid, captured_at=captured_at, read=lambda: fid.encode())


def test_holdout_by_camera_and_by_time():
    frames = [frame("a", 101, 10), frame("b", 102, 20), frame("c", 102, 5)]
    assert [f.path for f in select_holdout(frames, cameras=[102])] == ["b", "c"]
    assert [f.path for f in select_holdout(frames, since=10)] == ["a", "b"]


def test_measures_both_models_and_proposes_candidate_floors():
    frames = [frame(f"f{i}", 101 if i % 2 else 102) for i in range(6)]

    def baseline(jpeg):
        # Finds people at 0.7 only on camera 102 frames (even ids), and one FP.
        idx = int(jpeg.decode()[1:])
        dets = [Detection("person", 0.9, FP_BOX)] if idx == 0 else []
        if idx % 2 == 0:
            dets.append(Detection("person", 0.7, BOX))
        return dets

    def candidate(jpeg):
        idx = int(jpeg.decode()[1:])
        dets = [Detection("person", 0.6, BOX)]
        if idx == 1:
            dets.append(Detection("person", 0.55, FP_BOX))
        if idx == 3:
            dets.append(Detection("person", 0.45, FP_BOX))
        return dets

    report = compare_models(
        frames,
        baseline=baseline,
        candidate=candidate,
        baseline_floors={"person": 0.65, "vehicle": 0.5, "animal": 0.5},
        policy=FloorPolicy(min_support=3),
    )

    person = report["classes"]["person"]
    assert person["baseline"]["recall"] == 0.5
    assert person["proposedFloor"]["value"] == 0.5
    assert person["proposedFloor"]["reason"] == "fp-budget"
    assert person["candidate"]["recall"] == 1.0
    assert person["candidate"]["fp"] <= person["baseline"]["fp"]
    assert person["recallDeltaByCamera"] == {"101": 1.0, "102": 0.0}
    assert report["classes"]["vehicle"]["proposedFloor"]["reason"] == "low-support"
