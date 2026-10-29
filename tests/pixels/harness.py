"""Independent analytic fixtures and strict, bounded RGBA comparisons.

No GPU output is ever used to regenerate a fixture. Geometry is evaluated in
pixel coordinates on the CPU, independently of shader transforms and storage.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import struct
import zlib

WIDTH = HEIGHT = 64
NAMES = ("clear", "triangle", "textured-quad", "instanced-rects", "compute", "msaa")
# A pixel differs iff at least one channel exceeds tolerance. No pixels are
# masked: differing edge pixels consume exactly the same budget as any others.
POLICY = {
    "clear": (2, 0),
    "triangle": (2, 48),
    "textured-quad": (2, 0),
    "instanced-rects": (2, 0),
    "compute": (2, 0),
    "msaa": (2, 128),
}
HERE = Path(__file__).resolve().parent
SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png_bytes(rgba: bytes, width: int = WIDTH, height: int = HEIGHT) -> bytes:
    if len(rgba) != width * height * 4:
        raise ValueError("RGBA byte length does not match dimensions")

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = b"".join(b"\0" + rgba[y * width * 4 : (y + 1) * width * 4] for y in range(height))
    return (SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def read_png(path: Path) -> tuple[int, int, bytes]:
    """Decode the deliberately simple RGBA8 fixture format, validating CRCs."""
    data = path.read_bytes()
    if not data.startswith(SIGNATURE):
        raise ValueError(f"{path}: invalid PNG signature")
    offset, compressed, dimensions, ended = 8, bytearray(), None, False
    while offset < len(data):
        if len(data) - offset < 12:
            raise ValueError(f"{path}: truncated chunk")
        length = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4 : offset + 8]
        end = offset + 8 + length
        if end + 4 > len(data):
            raise ValueError(f"{path}: truncated payload")
        payload = data[offset + 8 : end]
        if zlib.crc32(kind + payload) != struct.unpack_from(">I", data, end)[0]:
            raise ValueError(f"{path}: bad CRC")
        if kind == b"IHDR":
            if dimensions is not None or length != 13:
                raise ValueError(f"{path}: invalid IHDR")
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            if (depth, color, compression, filtering, interlace) != (8, 6, 0, 0, 0):
                raise ValueError(f"{path}: expected noninterlaced RGBA8")
            dimensions = (width, height)
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            if length or end + 4 != len(data):
                raise ValueError(f"{path}: invalid PNG ending")
            ended = True
        offset = end + 4
    if not dimensions or not ended:
        raise ValueError(f"{path}: missing IHDR/IEND")
    width, height = dimensions
    rows = zlib.decompress(compressed)
    stride = width * 4
    if len(rows) != (stride + 1) * height:
        raise ValueError(f"{path}: invalid scanline length")
    rgba = bytearray()
    for y in range(height):
        row = rows[y * (stride + 1) : (y + 1) * (stride + 1)]
        if row[0] != 0:
            raise ValueError(f"{path}: fixture encoder must use filter 0")
        rgba.extend(row[1:])
    return width, height, bytes(rgba)


def inside_triangle(x: float, y: float) -> bool:
    # Vertices (8,56), (56,56), (32,8), expressed as half-plane tests.
    return y >= 8 and y < 56 and x >= 36 - y / 2 and x < 28 + y / 2


def reference(name: str) -> bytes:
    if name not in NAMES:
        raise ValueError(f"unknown sample {name}")
    output = bytearray()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            pixel = (0, 0, 0, 255)
            if name == "clear":
                pixel = (64, 128, 191, 255)
            elif name == "triangle":
                if inside_triangle(x + 0.5, y + 0.5):
                    pixel = (64, 191, 128, 255)
            elif name == "textured-quad":
                pixel = ((255, 0, 0, 255), (0, 255, 0, 255),
                         (0, 0, 255, 255), (255, 255, 255, 255))[(y // 32) * 2 + x // 32]
            elif name == "instanced-rects":
                # 8x8 grid of 6x6 rectangles inset one pixel, radius two.
                # Membership comes from a rectangle plus four circles, not SDF.
                local_x, local_y = x % 8 + 0.5 - 1, y % 8 + 0.5 - 1
                if 0 <= local_x < 6 and 0 <= local_y < 6:
                    cx = min(4, max(2, local_x))
                    cy = min(4, max(2, local_y))
                    if (local_x - cx) ** 2 + (local_y - cy) ** 2 <= 4:
                        pixel = (255, 128, 64, 255)
            elif name == "compute":
                value = (y * WIDTH + x) * 3 + 7
                pixel = (value & 255, (value >> 8) & 255, 0, 255)
            elif name == "msaa":
                # Standard rotated four-sample pattern. WebGPU permits other
                # patterns; differences still count against the finite budget.
                coverage = sum(inside_triangle(x + sx, y + sy) for sx, sy in
                               ((3 / 8, 1 / 8), (7 / 8, 3 / 8), (1 / 8, 5 / 8), (5 / 8, 7 / 8))) / 4
                pixel = tuple(int(channel * coverage + 0.5) for channel in (63.75, 191.25, 127.5)) + (255,)
            output.extend(pixel)
    return bytes(output)


def compare(name: str, expected: bytes, actual: bytes) -> dict[str, int]:
    if len(expected) != WIDTH * HEIGHT * 4 or len(actual) != len(expected):
        raise AssertionError(f"{name}: expected {WIDTH * HEIGHT * 4} RGBA bytes, got {len(actual)}")
    tolerance, cap = POLICY[name]
    different, maximum = 0, 0
    for offset in range(0, len(expected), 4):
        delta = max(abs(actual[offset + c] - expected[offset + c]) for c in range(4))
        maximum = max(maximum, delta)
        different += delta > tolerance
    if different > cap:
        raise AssertionError(f"{name}: {different} differing pixels exceed cap {cap}; max channel delta {maximum}, tolerance {tolerance}")
    return {"different_pixels": different, "maximum_channel_delta": maximum, "tolerance": tolerance, "cap": cap}


def verify_compute(data: bytes) -> None:
    if len(data) != 4096 * 4:
        raise AssertionError(f"compute: expected 16384 buffer bytes, got {len(data)}")
    for index, (actual,) in enumerate(struct.iter_unpack("<I", data)):
        expected = index * 3 + 7
        if actual != expected:
            raise AssertionError(f"compute[{index}]: expected {expected}, got {actual}")


def check_directory(directory: Path, names=NAMES) -> None:
    for name in names:
        width, height, expected = read_png(HERE / "expected" / f"{name}.png")
        if (width, height) != (WIDTH, HEIGHT):
            raise AssertionError(f"{name}: wrong fixture dimensions")
        actual = (directory / f"{name}.rgba").read_bytes()
        (directory / f"{name}.png").write_bytes(png_bytes(actual))
        result = compare(name, expected, actual)
        if name == "compute":
            verify_compute((directory / "compute.u32").read_bytes())
        print(f"{name}: {result['different_pixels']}/{result['cap']} differing pixels; max channel delta {result['maximum_channel_delta']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--regenerate", action="store_true", help="explicitly regenerate fixtures from the CPU oracle, never GPU output")
    parser.add_argument("--actual", type=Path)
    args = parser.parse_args()
    if args.regenerate:
        expected = HERE / "expected"
        expected.mkdir(parents=True, exist_ok=True)
        for name in NAMES:
            (expected / f"{name}.png").write_bytes(png_bytes(reference(name)))
    elif args.actual:
        check_directory(args.actual)
    else:
        parser.error("choose --regenerate or --actual DIR")


if __name__ == "__main__":
    main()
