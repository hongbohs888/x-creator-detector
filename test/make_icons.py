"""生成插件图标（纯标准库，不依赖 PIL）。用法：python3 make_icons.py <输出目录>"""
import struct
import sys
import zlib
from pathlib import Path


def png(size, pixel):
    rows = b"".join(b"\x00" + bytes(c for x in range(size) for c in pixel(x, y)) for y in range(size))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def lens(size):
    """黑底圆角方块上一枚蓝色镜片，带手柄。4x 超采样抗锯齿。"""
    ss = 4

    def sample(px, py):
        u, v = px / size, py / size
        r = 0.22
        cx, cy = min(max(u, r), 1 - r), min(max(v, r), 1 - r)
        if (u - cx) ** 2 + (v - cy) ** 2 > r * r:
            return (0, 0, 0, 0)
        d = ((u - 0.43) ** 2 + (v - 0.43) ** 2) ** 0.5
        if d < 0.19:
            return (29, 155, 240, 255)
        if d < 0.27:
            return (255, 255, 255, 255)
        t = ((u - 0.43) + (v - 0.43)) / 2
        off = abs((u - 0.43) - (v - 0.43)) / 2
        if 0.17 < t < 0.36 and off < 0.055:
            return (255, 255, 255, 255)
        return (15, 20, 25, 255)

    def pixel(x, y):
        acc = [0, 0, 0, 0]
        for sy in range(ss):
            for sx in range(ss):
                r, g, b, a = sample(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss)
                acc[0] += r * a
                acc[1] += g * a
                acc[2] += b * a
                acc[3] += a
        if not acc[3]:
            return (0, 0, 0, 0)
        return (acc[0] // acc[3], acc[1] // acc[3], acc[2] // acc[3], acc[3] // (ss * ss))

    return png(size, pixel)


if __name__ == "__main__":
    out = Path(sys.argv[1])
    for s in (16, 48, 128):
        (out / f"icon{s}.png").write_bytes(lens(s))
        print("wrote", out / f"icon{s}.png")
