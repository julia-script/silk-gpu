# Scene renderer design

The scene renderer draws 2D vector scenes (paths, strokes, gradients, images, layers) for the UI
stack and for SVG. It follows the sparse-strips design of
[vello_hybrid / vello_cpu](https://github.com/linebender/vello/tree/main/sparse_strips):
geometry and coverage are computed on the CPU, and the GPU only paints and composites. A CPU
reference renderer produces the same bytes from the same coverage, so every GPU change is held to
pixel parity.

## Packages

| Package | Role | Depends on |
| --- | --- | --- |
| `vector` | Pure Silk, no GPU: geometry, paths, flattening, stroking, coverage strips, paints, CPU reference pixmap | stdlib only |
| `gpu_scene` (planned) | Uploads strips and paints, records the paint and composite passes | `vector`, `webgpu` |

`vector` has no WebGPU dependency, so an SVG renderer, a test suite or a headless tool can use it
without Dawn.

## Pipeline

1. **Path** (`vector.path`): verbs and points in user space. Arcs and shapes are converted to
   cubics by callers (the SVG layer owns SVG arc conversion).
2. **Flatten** (`vector.flatten`): control points are transformed to device space first, then each
   quadratic or cubic is split uniformly into `n` segments from Wang's formula,
   `n = ceil(sqrt(d(d-1)/8 * M / tolerance))`, where `M` is the largest second difference of the
   control points. The default tolerance is 0.25 device pixels. Subpaths close implicitly for fills.
   Non-finite points and horizontal segments are dropped; they add no area.
3. **Stroke** (planned, PR 2): strokes are expanded into fill outlines before flattening, with the
   SVG 2 joins (miter, miter-clip, round, bevel, arcs), caps and dashes, and filled with nonzero.
4. **Coverage** (`vector.strips`): exact signed area per pixel cell, accumulated and prefix-summed
   along each row (the font-rs method). Nonzero coverage is `min(|a|, 1)`; even-odd is
   `|a - 2 round(a / 2)|`. Lines are split at x = 0 and x = width and then clamped, so geometry
   left of the canvas keeps its winding; rows outside the canvas are skipped.
5. **Strips**: the canvas is cut into bands of 4 rows aligned to y = 0. Within each band, a pixel
   column is empty, solid or partial. Runs of partial columns become a `Strip` with 4 alpha bytes
   per column, stored column major so a column is one `u32` on the GPU. Runs of solid columns
   become a `Fill`, which carries no alphas. Lines are binned into bands with a counting sort, and
   only the path's bounding box is visited.
6. **Paint and composite** (CPU: `vector.pixmap`; GPU: `gpu_scene`): each strip or fill is drawn
   with its paint. The target is premultiplied RGBA8. Every blend uses the exact integer
   `div255(x) = (x + 128 + ((x + 128) >> 8)) >> 8`, which equals `round(x / 255)` for all
   products of two bytes, so CPU and GPU can agree byte for byte.

## Planned work

| PR | Content | Exit test |
| --- | --- | --- |
| 1 | This document; `vector` geometry, path, flatten, strips, pixmap with solid source-over | Area and edge tests in `vector/src/tests.silk` |
| 2 | Stroker: joins, caps, dashes, `vector-effect` friendly (stroke in device or user space) | Analytic stroke areas, join and cap shapes |
| 3 | Paints: solid, linear, radial (two-point conical with `fr` and focal point), spread pad/reflect/repeat, image patterns with transforms | Gradient stop and spread tests |
| 4 | Layers: group opacity, the 16 separable and non-separable blend modes, clip paths (coverage intersection) and luminance/alpha masks | Compositing tests against the formulas in Compositing and Blending Level 1 |
| 5 | `gpu_scene`: strip and fill instances, paint shaders in WGSL, layer stack with offscreen targets | GPU output equals the CPU pixmap with 0 differing pixels on lavapipe |
| 6 | Filter primitives the SVG renderer needs, then benchmarks against tiny-skia and vello_cpu | Scheduled benchmark job, not PR CI |

## Choices

- **Coverage on the CPU.** Flattening and coverage are branchy and data dependent; they are cheap
  on the CPU for UI-sized scenes and need no compute shaders, which keeps the browser path and
  lavapipe CI working. Moving coarse rasterization to compute is possible later behind the same
  strip format.
- **Column granularity.** Strips start and end at any column, not at 4-pixel tile edges. This
  emits fewer alpha bytes than tile-aligned strips for thin shapes and keeps solid runs exact.
- **f32 coverage, f64 geometry.** User-space math is f64 so large transforms keep precision;
  device-space lines and area accumulation are f32 like the GPU.
- **Antialiasing only by area.** No MSAA. `shape-rendering: crispEdges` can be served later by
  snapping coverage to 0 or 255.
