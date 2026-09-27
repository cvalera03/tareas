#!/usr/bin/env python3
"""Genera los iconos PNG de la app (solo librería estándar). Uso: python3 tools/make_icons.py"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "icons")
BG = (88, 86, 214)  # índigo de Tareas
WHITE = (255, 255, 255)


def seg_dist(x, y, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - ax - t * dx, y - ay - t * dy)


def shade(x, y):
    """Casa blanca con una marca de «hecho» en coordenadas normalizadas 0..1."""
    # Marca de hecho, del color del fondo, dentro de la casa
    if min(seg_dist(x, y, 0.38, 0.60, 0.47, 0.69), seg_dist(x, y, 0.47, 0.69, 0.64, 0.51)) <= 0.035:
        return BG
    # Tejado: triángulo con vértice arriba
    if 0.20 <= y <= 0.47:
        half = (y - 0.20) / 0.27 * 0.33
        if abs(x - 0.5) <= half:
            return WHITE
    # Cuerpo con esquinas inferiores redondeadas
    bx0, bx1, by0, by1, r = 0.27, 0.73, 0.44, 0.80, 0.05
    if bx0 <= x <= bx1 and by0 <= y <= by1:
        cy = min(y, by1 - r)
        cx = min(max(x, bx0 + r), bx1 - r)
        if y <= by1 - r or math.hypot(x - cx, y - cy) <= r:
            return WHITE
    return None


def render(size, rounded):
    ss = 3
    rows = []
    rad = 0.2237 * size
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss)
                    y = (py + (sy + 0.5) / ss)
                    inside = True
                    if rounded:
                        cx = min(max(x, rad), size - rad)
                        cy = min(max(y, rad), size - rad)
                        inside = math.hypot(x - cx, y - cy) <= rad
                    if not inside:
                        continue
                    c = shade(x / size, y / size) or BG
                    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255
            n = ss * ss
            a = acc[3] / n
            if a:
                w = acc[3] / 255  # nº de submuestras cubiertas
                row += bytes([int(acc[0] / w), int(acc[1] / w), int(acc[2] / w), int(a)])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


os.makedirs(OUT, exist_ok=True)
# iOS aplica su propia máscara redondeada: el apple-touch-icon va cuadrado y opaco.
for name, size, rounded in [("apple-touch-icon.png", 180, False), ("icon-192.png", 192, True), ("icon-512.png", 512, False)]:
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(render(size, rounded))
    print("ok", name)
