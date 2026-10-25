"""Postprocessor dispatch table for inference_pool.py.

Each postprocessor takes raw model output (dict of numpy arrays) and model config,
returns a structured dict matching the StepOutput JSON format.
"""
from .yolo import postprocess_yolo
from .yolo_seg import postprocess_yolo_seg
from .scrfd import postprocess_scrfd
from .arcface import postprocess_arcface
from .clip import postprocess_clip
from .softmax import postprocess_softmax
from .ctc import postprocess_ctc
from .plate_slots import postprocess_plate_slots
from .saliency import postprocess_saliency
from .yamnet import postprocess_yamnet
from .ssd import postprocess_ssd
from .rfdetr import postprocess_rfdetr
from .yolonas import postprocess_yolonas
from .yunet import postprocess_yunet
from .yolo_split_dfl import postprocess_yolo_split_dfl

POSTPROCESSORS = {
    "yolo": postprocess_yolo,
    "yolo-seg": postprocess_yolo_seg,
    "scrfd": postprocess_scrfd,
    "arcface": postprocess_arcface,
    "clip": postprocess_clip,
    "softmax": postprocess_softmax,
    "ctc": postprocess_ctc,
    "plate-slots": postprocess_plate_slots,
    "saliency": postprocess_saliency,
    "yamnet": postprocess_yamnet,
    "ssd": postprocess_ssd,
    "rfdetr": postprocess_rfdetr,
    "yolonas": postprocess_yolonas,
    "yunet": postprocess_yunet,
    "yolo-split-dfl": postprocess_yolo_split_dfl,
}
