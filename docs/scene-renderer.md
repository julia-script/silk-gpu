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
3. **Stroke** (`vector.stroke`): strokes are expanded in user space into closed outlines that are
   filled with nonzero, so the CTM (including skew and non-uniform scale) applies to the pen as SVG
   requires. The centerline is flattened at the device tolerance divided by the transform's
   largest singular value. Joins: miter (falls back to bevel past `stroke-miterlimit`),
   miter-clip, round, bevel, and arcs (on flattened segments arcs have zero curvature, so they
   behave as miter-clip; using source curvature is future work). Caps: butt, round, square,
   including the dots SVG 2 requires for zero-length subpaths. Vertices inside a flattened curve
   always get a round join. Inner joins end at the intersection of the two offset lines when both
   segments are long enough, and otherwise pass through the vertex: such overlaps reach the inner
   edge, where clamping per-pixel area would overstate coverage, so they are only the fallback.
   Round arcs place interior vertices on a radius that keeps the arc's area. Dashes are cut from
   the flattened centerline (odd lists repeat, negative or all-zero lists disable dashing, the
   pattern restarts per subpath).
4. **Coverage** (`vector.strips`): exact signed area per pixel cell, accumulated and prefix-summed
   along each row (the font-rs method). Nonzero coverage is `min(|a|, 1)`; even-odd is
   `|a - 2 round(a / 2)|`. Lines are split at x = 0 and x = width and then clamped, so geometry
   left of the canvas keeps its winding; rows outside the canvas are skipped.
5. **Strips**: the canvas is cut into bands of 4 rows aligned to y = 0. Within each band, a pixel
   column is empty, solid or partial. Runs of partial columns become a `Strip` with 4 alpha bytes
   per column, stored column major so a column is one `u32` on the GPU. Runs of solid columns
   become a `Fill`, which carries no alphas. Lines are binned into bands with a counting sort, and
   only the path's bounding box is visited.
6. **Paint and composite** (CPU: `vector.pixmap` and `vector.paint`; GPU: `gpu_scene`): each
   strip or fill is drawn with its paint, a `Shader` that returns the premultiplied color at a
   device pixel center. Paints carry one transform from their own space to device space (callers
   fold in `gradientTransform`, `objectBoundingBox` units and the CTM) and sample at
   `(x + 0.5, y + 0.5)` mapped through its inverse.
   - Gradients: linear, and radial in the SVG 2 two-point conical form (focal circle `fx fy fr`
     to end circle `cx cy r`, taking the largest `t` with a non-negative radius; points outside
     a cone stay transparent). Spread pad, reflect and repeat. Stop offsets are clamped and made
     non-decreasing; equal offsets give hard edges; a zero-length vector or zero radius paints
     the last stop. Colors are tabulated into a 1024-entry premultiplied ramp; interpolation is in
     straight alpha by default (resvg and Skia's SVG behaviour) or premultiplied (CSS Images 3).
     Color-space choice (`color-interpolation: linearRGB`) is the caller's, by converting stops.
   - Image patterns: nearest or bilinear sampling of a premultiplied pixmap, clamped (for
     `image`, clipped by its rectangle) or repeated (pattern tiles).
   - Opacity (`fill-opacity`, `stroke-opacity`) scales the coverage mask.
   The target is premultiplied RGBA8. Every blend uses the exact integer
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
