"""Saliency / segmentation refiner postprocessor.

Used for: u2netp.

Input: raw saliency map tensor
Output: {"kind": "mask", "mask": "<base64>", "maskWidth": N, "maskHeight": N}
"""
import base64
import numpy as np


def _largest_component_bbox(binary: np.ndarray) -> tuple[int, int, int, int] | None:
    """Bounding box [x, y, w, h] (mask space) of the largest 4-connected
    foreground component. Pure-numpy flood fill — no OpenCV dependency.
    Returns None when there is no foreground pixel."""
    h, w = binary.shape
    fg = binary > 0
    visited = np.zeros((h, w), dtype=bool)
    best: tuple[int, int, int, int, int] | None = None  # (area, x, y, w, h)
    ys, xs = np.nonzero(fg)
    for sy, sx in zip(ys.tolist(), xs.tolist()):
        if visited[sy, sx]:
            continue
        stack = [(sy, sx)]
        visited[sy, sx] = True
        minx = maxx = sx
        miny = maxy = sy
        area = 0
        while stack:
            cy, cx = stack.pop()
            area += 1
            if cx < minx:
                minx = cx
            if cx > maxx:
                maxx = cx
            if cy < miny:
                miny = cy
            if cy > maxy:
                maxy = cy
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < h and 0 <= nx < w and fg[ny, nx] and not visited[ny, nx]:
                    visited[ny, nx] = True
                    stack.append((ny, nx))
        if best is None or area > best[0]:
            best = (area, minx, miny, maxx - minx + 1, maxy - miny + 1)
    if best is None:
        return None
    return (best[1], best[2], best[3], best[4])


def postprocess_saliency(
    predictions: dict,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
) -> dict:
    """Sigmoid → threshold → binary mask → base64."""
    mask_threshold = config.get("maskThreshold", 0.5)

    # U2-Net outputs multiple saliency maps; use the first (highest resolution)
    raw = np.array(list(predictions.values())[0]).astype(np.float32)

    # Remove batch/channel dims to get [H, W]
    while raw.ndim > 2:
        raw = raw[0]

    # Sigmoid
    saliency = 1.0 / (1.0 + np.exp(-raw))

    # Threshold to binary uint8 (0 or 255)
    binary = (saliency > mask_threshold).astype(np.uint8) * 255

    h, w = binary.shape
    mask_b64 = base64.b64encode(binary.tobytes()).decode("ascii")

    result = {
        "kind": "mask",
        "mask": mask_b64,
        "maskWidth": int(w),
        "maskHeight": int(h),
    }

    bbox = _largest_component_bbox(binary)
    if bbox is not None:
        bx, by, bw, bh = bbox
        result["maskBbox"] = [int(bx), int(by), int(bw), int(bh)]

    return result
