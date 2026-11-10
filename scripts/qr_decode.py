"""Decode QR matrices with OpenCV. Reads JSON [{"text": str, "size": int, "rows": ["0101...", ...]}] on stdin,
prints JSON [{"ok": bool, "decoded": str}]. Used by tests/qr.test.ts to verify the TypeScript encoder.

Uses cv2.QRCodeDetectorAruco. The older cv2.QRCodeDetector intermittently fails to *locate* valid codes for some mask
patterns at high versions (the same codewords decode under other masks and with this detector), so it is not a
reliable oracle for correctness."""
import json
import sys

import cv2
import numpy as np

SCALE, QUIET = 8, 4
out = []
for item in json.load(sys.stdin):
    n = item["size"]
    img = np.full(((n + 2 * QUIET) * SCALE,) * 2, 255, dtype=np.uint8)
    for y, row in enumerate(item["rows"]):
        for x, c in enumerate(row):
            if c == "1":
                img[(y + QUIET) * SCALE:(y + QUIET + 1) * SCALE, (x + QUIET) * SCALE:(x + QUIET + 1) * SCALE] = 0
    decoded, _, _ = cv2.QRCodeDetectorAruco().detectAndDecode(img)
    out.append({"ok": decoded == item["text"], "decoded": decoded})
json.dump(out, sys.stdout)
