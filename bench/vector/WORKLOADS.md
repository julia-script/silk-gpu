# vector CPU workloads

`vector_bench` (Silk) and `bench/vector/tiny-skia` (Rust, tiny-skia 0.11) draw the same six
scenes on a 512 x 512 canvas cleared to opaque white. Geometry comes from one PCG-style LCG,
`state = state * 6364136223846793005 + 1442695040888963407` (wrapping u64, seed 7 per scene),
and `next() = (state >> 11) / 2^53`. Both programs draw the exact same paths: circles are four
cubics with handle ratio 0.5522847498307936, stars are ten lines.

| Scene | Content |
| --- | --- |
| fills | 300 circles: `cx = 512 n, cy = 512 n, r = 4 + 60 n`, color `(255 n, 255 n, 255 n, 128 + 127 n)`, nonzero |
| strokes | 150 five-point stars: `cx = 512 n, cy = 512 n, outer = 10 + 50 n, inner = 0.4 outer`, width `1 + 6 n`, round joins, butt caps, opaque `(255 n, 255 n, 255 n)` |
| gradients | 100 rects `x = 462 n, y = 462 n, w = 10 + 90 n, h = 10 + 90 n`; even indices linear from the top-left to the bottom-right corner, odd ones radial at the center with radius `max(w, h) / 2`; stops at 0, 0.5, 1 with colors `(255 n, 255 n, 255 n, 255)` drawn in that order; pad |
| icons | 4000 glyph-sized shapes: `cx = 512 n, cy = 512 n, size = 2 + 10 n`, opaque `(255 n, 255 n, 255 n)`; even indices circles of radius `size`, odd ones stars with `outer = size, inner = 0.4 size`; nonzero. Per-path overhead dominates |
| images | 60 rects `x = 412 n, y = 412 n, w = 20 + 80 n, h = 20 + 80 n` filled with a 64 x 64 opaque tile (8-pixel checker: dark squares `(2x, 3y, 40)`, light `(255 - 2x, 250 - 3y, 200)`) placed by `[s cos t, s sin t, -s sin t, s cos t, x, y]` with `t = pi n`, `s = 0.5 + 1.5 n`; bilinear, repeat |
| polygon | one 4000-vertex polygon around (256, 256), vertex `i` at angle `2 pi i / 4000 * 37` (it winds 37 times) and radius `30 + 220 n`, even-odd |

Each program renders each scene for the requested number of frames, prints `scene ms-per-frame`
lines (median of the frames), and writes the last frame as `<prefix>-<scene>.rgba`
(premultiplied RGBA8) so `scripts/bench-vector` can compare the two images.
