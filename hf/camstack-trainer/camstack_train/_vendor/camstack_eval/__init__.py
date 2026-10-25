"""CamStack detector evaluation harness (cloud-training P5).

Pipeline-identical preprocess and decode for YOLO ONNX detectors, P/R/AP50 per
macro class, camera, day/night and small subjects, a baseline vs candidate
comparison on a holdout, and the D739 floor rule. See `scripts/eval/evaluate.py`.
"""
