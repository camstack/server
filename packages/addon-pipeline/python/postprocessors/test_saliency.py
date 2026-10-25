import numpy as np
from saliency import _largest_component_bbox


def test_largest_component_drops_speckle():
    # 10x10 mask: a 4x3 main blob at (x=2,y=1) plus a 1px speckle at (8,8).
    binary = np.zeros((10, 10), dtype=np.uint8)
    binary[1:4, 2:6] = 255  # rows 1..3 (h=3), cols 2..5 (w=4)
    binary[8, 8] = 255       # speckle — must be dropped
    assert _largest_component_bbox(binary) == (2, 1, 4, 3)


def test_empty_mask_returns_none():
    binary = np.zeros((10, 10), dtype=np.uint8)
    assert _largest_component_bbox(binary) is None


def test_diagonal_pixels_are_not_4connected():
    # Two diagonal pixels are separate components; the "largest" is a 1x1.
    binary = np.zeros((4, 4), dtype=np.uint8)
    binary[0, 0] = 255
    binary[1, 1] = 255
    assert _largest_component_bbox(binary) == (0, 0, 1, 1)
