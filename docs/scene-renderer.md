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
| `gpu_scene` | Packs strips, alphas and paints into storage buffers and draws them in one instanced render pass | `vector`, `webgpu` |
| `scene_tests` | Renders the same scenes on the CPU and the GPU and compares bytes (`scripts/test-scene`, in the gate) | all of the above |

`vector` has no WebGPU dependency, so an SVG renderer, a test suite or a headless tool can use it
without Dawn.

## Pipeline

1. **Path** (`vector.path`): verbs and points in user space, including generic affine ellipse
   arcs. Callers own format-specific conversion (for example, SVG endpoint arcs to an ellipse
   center, basis vectors, start angle, and sweep); the vector package has no SVG-specific types.
   `Path.ellipseArcTo(center, axisX, axisY, startAngle, sweepAngle, end)` preserves an exact end
   anchor; its start anchor is the current point. The basis need not be orthogonal. The generic
   `ellipseArc` convenience method computes the end anchor. Neither method inserts a connector.
   Anchor reconstruction error is charged to the accuracy budget, never hidden by an epsilon.
2. **Flatten** (`vector.flatten`): control points are transformed to device space first, then each
   quadratic or cubic is split uniformly into `n` segments from Wang's formula,
   `n = ceil(sqrt(d(d-1)/8 * M / tolerance))`, where `M` is the largest second difference of the
   control points. Ellipse arcs are sampled directly under the transform rather than approximated
   by cubics first. The default tolerance is 0.25 device pixels. Subpaths close implicitly for fills;
   horizontal segments add no area. Invalid input, unrepresentable numeric results, and unsupported
   accuracy requests propagate `geometry_error.GeometryError` through `Rasterizer.fill`.
   `Rasterizer.fill` uses `flatten.fillClipped`: viewport clipping happens in f64 before
   narrowing to f32, retaining vertical boundary edges so offscreen geometry preserves winding.
   Thus a finite enclosing rectangle at `±1e20` can cover a small viewport without requiring
   those irrelevant coordinates to meet the on-screen f32 error budget. Uncertifiable clipping
   interpolation fails explicitly; coordinates are never silently saturated before clipping.

   Projective callers use `vector.projective.Homography` and
   `projective.fill(path, transform, viewport, tolerance, lines)`. Curves remain homogeneous
   Béziers; ellipse arcs become exact rational quadratics, not polynomial approximations.
   Whole closed contours are clipped against positive w and the finite viewport before
   division and f32 narrowing, preserving closing edges and both fill-rule windings.
   `fillWithPlanes` additionally intersects device-homogeneous `HalfPlane { x, y, w }`
   constraints. Nested flattened projections need these intermediate visibility constraints:
   multiplying homographies alone can otherwise resurrect geometry behind a child's eye plane.
   The inverse parent's denominator supplies the corresponding device-space halfplane.

   `Homography.compose` computes parent × child with checked cancellation and positive
   power-of-two rescaling when direct arithmetic cannot represent the result. Positive common
   scaling preserves the map; a negative scale reverses visibility and is never discarded.
   `projective.bounds` measures unclipped f64 curve bounds, retaining positioned degenerates
   and excluding entirely negative-w geometry. An unbounded eye-plane crossing or unavailable
   precision is an error, not a viewport-sized replacement box. Projective subdivision allows
   48 levels and 1,048,576 combined curve, extra-plane and clipping-vertex visits; partial
   output after failure must be discarded.
3. **Stroke** (`vector.stroke`): `Stroker.stroke(path, style, transform, tolerance, out)`
   expands a path into a user-space outline for nonzero filling. The caller applies the transform
   when filling, so skew and non-uniform scale transform the pen too. Tolerance is explicit,
   positive, finite, and measured in target coordinates, not user coordinates. Resolution accounts
   for both centerline error and the width-dependent offset error; cap and join directions come
   from source-segment endpoint tangents, not flattened chords. The transform's largest singular
   value is calculated with normalization so large finite entries do not spuriously overflow.
   Joins are miter (bevel beyond the miter limit), miter-clip, round, bevel, and arcs; arcs joins use
   source endpoint curvature to extend the two offset curves. Straight-segment arcs joins reduce
   to miter-clip. Caps are butt, round, and square, including round/square dots on zero-length
   subpaths. Dashes repeat odd lists and restart per subpath; negative or all-zero lists disable
   dashing.
   Curve subdivision bounds both offsets directly: for unit normal `N` and speed lower bound
   `v`, `|N''| <= |P'''|/v + 3|P''|²/v²`, and linear interpolation error is at most the
   second-derivative bound times `dt²/8`. Endpoint scalar zeros are removed before normalizing
   Bézier derivatives, preserving limiting cap directions. Ellipse derivatives and curvature
   remain analytic; circles are not first converted to cubics. Arcs joins adjust nonintersecting
   osculating circles and clip against the circular-bisector arclength miter limit defined by
   [SVG 2 stroke joins](https://svgwg.org/svg2-draft/painting.html#LineJoinShape).
   Dashes use a separate arc-length error budget scaled by the width-dependent offset motion.
   An unresolved transition across a genuine source corner is an accuracy failure, not a guessed
   cap or join. Zero-length on-dashes retain their cap shape.

   `Stroker.bounds(path, style, transform, tolerance, ignoreDashes)` returns
   `StrokeBounds { empty, bounds }` in target coordinates, from transformed stroke geometry rather
   than a mapped user-space bounding rectangle. Set `ignoreDashes` for undashed stroke bounds.
   The stroker retains its outline scratch between bounds calls. Bounds pad the transformed
   polygon extrema by half the requested tolerance: the internal approximation budget is smaller
   than that padding, and each returned face is at most one tolerance outside the mathematical
   stroke box. This is a bounded conservative result, not a claim of analytic exact extrema.
   Both operations propagate allocation failure and `geometry_error.GeometryError`, whose `code`
   distinguishes `INVALID_INPUT` (including invalid tolerance), `NUMERIC_LIMIT` (unrepresentable
   arithmetic or coordinates), and `ACCURACY_LIMIT` (the requested resolution exceeds available
   floating-point precision or the supported subdivision budget). They must not silently return
   coarse geometry when either accuracy limit is reached.
   The current refusal limits are 40 subdivision levels and 1,048,576 curve samples or circular
   arc segments; none is a successful-return clamp. Roundoff guards also reject absolute
   tolerances below available coordinate precision (for example, `0.1` at scale `1e200`).
   Any partially appended outline after an error must be discarded. `bounds` returns no box on
   error. Width zero returns empty geometry; negative widths and invalid style values are errors.
   Contract tests in `vector/src/stroke_tests.silk` also reference
   [SVG 2 line caps](https://www.w3.org/TR/SVG2/painting.html#LineCaps) and
   [stroke bounding boxes](https://www.w3.org/TR/SVG2/coords.html#BoundingBoxes).

   `Stroker.strokeProjective(path, style, homography, viewport, tolerance, out)` still produces
   a **source-space** pen outline. It bounds the projective Jacobian over the expanded target
   viewport using the inverse denominator, then reuses source tangents, curvature, caps, joins
   and dash lengths. It never strokes a projected centerline. Divide a desired total target
   error between stroking and subsequent projective flattening.

   `Stroker.boundsProjective(..., tolerance, ignoreDashes)` needs no viewport. A guarded source
   error tube certifies each connected contour's homogeneous sign; disconnected behind-eye
   contours are ignored, while genuine crossings fail explicitly. Finite source-coordinate
   bounds then certify the Jacobian for refinement and outward-padded f64 reference bounds.
   A source AABB crossing w = 0 does not by itself imply an unbounded stroke. The adaptive
   source-tolerance search has a 64-refinement refusal limit in addition to the stroker and
   projective subdivision limits.
4. **Coverage** (`vector.strips`): exact signed area per pixel cell, accumulated and prefix-summed
   along each row (the font-rs method). Nonzero coverage is `min(|a|, 1)`; even-odd is
   `|a - 2 round(a / 2)|`. Lines are split at x = 0 and x = width and then clamped, so geometry
   left of the canvas keeps its winding; rows outside the canvas are skipped.
5. **Strips**: the canvas is cut into bands of 4 rows aligned to y = 0. Within each band, a pixel
   column is empty, solid or partial. Runs of partial columns become a `Strip` with 4 alpha bytes
   per column, stored column major so a column is one `u32` on the GPU. Runs of solid columns
   become a `Fill`, which carries no alphas. Every line is accumulated once into an area buffer
   covering the path's bounding box; each band then resolves only the columns a line touched (an
   untouched column repeats the one before it) and zeroes the cells it read for the next path.
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
     `image`, clipped by its rectangle) or repeated (pattern tiles). Affine CPU sampling is f32
     with separately rounded operations on the inverse rounded to f32, four pixels per step.
     Native scene shaders use strict math at nearest-texel boundaries.
   - Projective paints: `Gradient.linearProjective`, `Gradient.radialProjective` and
     `ImagePattern.makeProjective` take a homography and perform inverse homogeneous division.
     Negative inverse w is valid; zero inverse w paints transparent. Genuinely singular maps
     paint nothing; unsupported numeric precision and nonfinite input report `GeometryError`.
     Projective image coordinates use explicit
     `fma(yCoefficient, fy, fma(xCoefficient, fx, offset))` per homogeneous row on CPU SIMD and
     WGSL. This shared rounding contract is necessary even with native strict math: implicit
     contraction otherwise changed one bilinear image channel by one byte.
   - Opacity (`fill-opacity`, `stroke-opacity`) scales the coverage mask.
   The target is premultiplied RGBA8. Every blend uses the exact integer
   `div255(x) = (x + 128 + ((x + 128) >> 8)) >> 8`, which equals `round(x / 255)` for all
   products of two bytes, so CPU and GPU can agree byte for byte.

7. **Layers** (`vector.layer`): a group that needs isolation (opacity below 1, a mask, a clip,
   a filter or a non-normal blend mode) is drawn into its own transparent pixmap and composited
   onto its parent with `composite` or `compositeMasked`, using the 16 blend modes of
   Compositing and Blending Level 1 (`normal` is exact integer source-over; the others compute
   `cs (1 - ab) + cb (1 - as) + as ab B(Cb, Cs)` in f32). A `Mask` is one byte per pixel: clip
   paths become masks from coverage and intersect by multiplication; `mask` content becomes a
   mask from its alpha or its luminance (CSS Masking coefficients 0.2125, 0.7154, 0.0721 on
   premultiplied values). `fillClipped` draws a path through a clip without a layer.

8. **GPU** (`gpu_scene`): a `Scene` records each coverage as runs (one instance per strip or fill:
   x, y, width, alpha word index or solid, paint index, opacity) plus the coverage alphas (one
   `u32` per column), paint records and gradient ramps. `SceneRenderer.render` uploads them and
   draws `6 x runs` vertices in one pass on an RGBA8Unorm target. The fragment shader masks the
   premultiplied paint with the same integer `div255` as the CPU, and the blend unit's
   `One, OneMinusSrcAlpha` computes `s + d (1 - as)`, which for unorm8 equals the CPU's
   `s + div255(d (255 - as))`, so solid fills match the CPU pixmap byte for byte. Gradients use
   the same formulas in f32. Image paints (`Scene.fillImage`) append the image's texels to the
   ramp buffer and sample them like `ImagePattern` (nearest or bilinear, clamp or repeat). Buffers
   are recreated per frame for now. Request `SceneRenderer.requiredFeatures()` through
   `DeviceDescriptor.withRequiredFeatures` when creating the scene's device. On native Dawn this
   enables `ShaderModuleCompilationOptions`; only the scene paint module is created with
   `strictMath = true`. A native device without the enabled feature fails renderer creation with
   `webgpu.resources.STRICT_MATH_UNAVAILABLE`, rather than silently rendering nonexact images.
   Ordinary WebGPU shader modules, composition, and filters retain their existing math mode.
   Solid and affine paint records remain 16 words. Projective kinds 4/5/6 use 19 words,
   appending the inverse denominator; run paint references are word offsets. Native projective
   fixtures retain the existing image tolerance of zero and gradient tolerance of two; the
   checked Metal run had zero differing image channels and gradient maximum delta one.

   This is necessary on Metal: relaxed arithmetic changed the image fixture's device column
   `x = 21` from source texel 1 to texel 2 (242 differing channels, maximum delta 130). The
   existing zero-tolerance CPU/GPU image comparison and an independent boundary-texel assertion
   protect that case. It also reproduced on untouched upstream base `2f25e03`, independently
   of stroke/path changes. Dawn's
   [pinned Metal compiler](https://github.com/google/dawn/blob/106704a9ac3fc21b1580ea85aea302ac17d416f1/src/dawn/native/metal/ShaderModuleMTL.mm)
   selects the Metal `safe` or `relaxed` math pragma from the per-module strict option.
   Browser WGSL has no equivalent portable strict-math feature: the required-feature list is
   empty there and the browser scene path retains standard WGSL arithmetic. Native exact-image
   results are not a claim of browser pixel parity.

9. **GPU layers** (`gpu_scene`): `Scene.pushLayer` starts a group, `popLayer(mode, opacity,
   mask)` composites it onto its parent, and `popMask(kind, clip)` turns the group into a mask
   (alpha or luminance, optionally multiplied by another mask, as `Mask.intersect` does) and
   returns its id. A scene with layers renders into textures: one for the root, one per group and
   mask, and one for a copy of the parent. Popping a group copies its parent and draws a
   full-target pass of `shaders/compose.wgsl` that computes `vector.layer`'s compositing on the
   bytes (integer source-over for `normal`, the same f32 formulas for the other modes), and the
   root is copied to the target at the end. The scene test renders all 16 blend modes, a
   luminance mask through a clip, and image patterns, and matches the CPU byte for byte on lavapipe. The renderer
   keeps its layer textures between renders, growing the pool as scenes need more and dropping
   it when the canvas size changes; the scene test renders the layered scene a second time on
   reused textures.

10. **Filters** (`vector.filter`, `gpu_scene.filter`): the Filter Effects primitives on
   canvas-sized premultiplied images, each writing the result inside its primitive subregion and
   transparent black elsewhere. Done so far: `feFlood`, `feOffset`, `feGaussianBlur` (the spec's
   three-box approximation for sigma >= 2 with the even-size offsets, a fixed-point kernel
   summing to 65536 below that), `feColorMatrix`, `feComposite` (Porter-Duff in integer
   `div255`, arithmetic in f32), `feMerge`, `feBlend`, `feMorphology` (separable min/max), `feComponentTransfer` (per-channel
   256-byte tables built in f64, applied to integer-unpremultiplied bytes), `feTile`,
   `feConvolveMatrix` (f32, all edge modes and `preserveAlpha`), `feDisplacementMap` (a per-byte
   whole-pixel displacement table, nearest neighbor), `feTurbulence` (the spec's reference noise; stitch
   lattice points are compared before masking, as resvg and browsers do, because the SVG 1.1
   listing masks first and never stitches), `feDiffuseLighting` and `feSpecularLighting`
   (distant, point and spot lights in device space; Sobel normals with the spec's one-sided
   edge kernels) and the linearRGB conversions. `feDropShadow` is a composition of these
   (blur, offset, flood, composite, merge), and `feImage` renders through the scene, so the SVG
   renderer builds both. Conversions
   go through a 256 x 256 table of `(alpha, channel)` so the GPU applies exactly the CPU's
   result. On the GPU each primitive is a full-target pass of `shaders/filter.wgsl` (blur takes
   one pass per box or kernel and ping-pongs through a scratch image); `blend.wgsl` holds the
   blend math shared with `compose.wgsl`, and `scripts/embed-shaders` prepends it. The scene test
   runs every primitive, operator, blend mode and several blur sizes on both sides and matches
   byte for byte on lavapipe. Scene integration (filter commands in `Scene`) comes with the SVG
   renderer, which decides the filter graph and region.

## Planned work

| PR | Content | Exit test |
| --- | --- | --- |
| 1 | This document; `vector` geometry, path, flatten, strips, pixmap with solid source-over | Area and edge tests in `vector/src/tests.silk` |
| 2 | Stroker: joins, caps, dashes, `vector-effect` friendly (stroke in device or user space) | Analytic stroke areas, join and cap shapes |
| 3 | Paints: solid, linear, radial (two-point conical with `fr` and focal point), spread pad/reflect/repeat, image patterns with transforms | Gradient stop and spread tests |
| 4 | Layers: group opacity, the 16 separable and non-separable blend modes, clip paths (coverage intersection) and luminance/alpha masks | Compositing tests against the formulas in Compositing and Blending Level 1 |
| 5 | `gpu_scene`: strip and fill instances, paint shaders in WGSL, layer stack with offscreen targets | GPU output equals the CPU pixmap with 0 differing pixels on lavapipe |
| 6 | Filter primitives the SVG renderer needs, then benchmarks against tiny-skia and vello_cpu | Scheduled benchmark job, not PR CI |

## Benchmarks

`scripts/bench-vector` (scheduled weekly in the benchmarks workflow, not in PR CI) renders the
six scenes of `bench/vector/WORKLOADS.md` with `vector` and with tiny-skia 0.11, prints the median
frame time of each, and compares the two images. Latest run (2026-10-29, x86_64 container, release
builds, 512 x 512):

| Scene | vector ms | tiny-skia ms | ratio | pixels differing by more than 8 |
| --- | ---: | ---: | ---: | ---: |
| fills (300 translucent circles) | 4.2 | 10.2 | 0.41x | 2.3% |
| strokes (150 round-joined stars) | 3.1 | 7.7 | 0.40x | 3.2% |
| gradients (100 linear and radial rects) | 2.9 | 4.6 | 0.63x | 0.0% |
| polygon (4000 edges, even-odd) | 3.7 | 21.7 | 0.17x | 30% |
| icons (4000 glyph-sized circles and stars) | 10.0 | 21.7 | 0.46x | 11% |
| images (60 rotated, scaled, repeated bilinear tiles) | 5.5 | 5.5 | 1.0x | 0.0% |

The first run, before the coverage and compositing work, was 2.20x, 1.33x, 3.75x and 0.54x.
What made the difference: coverage accumulates every line once into one buffer for the whole
path and resolves only columns a line touched (an untouched column repeats the one before it);
compositing works on packed pixels with a two-lane `div255`, four pixels at a time with
`silk.simd` for spans; shaders fill whole spans
(`Shader.shadeSpan`), stepping the linear parameter along the row, and a uniform paint
(`Shader.isUniform`, such as a solid color) skips shading and composites one color; gradient ramps interpolate in
fixed point.

The polygon difference is a known limit of area accumulation: the winding is clamped (nonzero)
or folded (even-odd) per pixel after integrating, so pixels crossed by several edges of one path
are approximate. tiny-skia supersamples four sub-scanlines and is closer there. Ordinary
overlaps only touch the few pixels where two boundaries cross. Accumulating per sub-row would
reduce it if it matters for real content.

### Filters

`scripts/bench-filters` (same schedule) runs nine filter primitives of
`bench/filters/WORKLOADS.md` with `vector.filter` and with resvg 0.45.1 on a 512 x 512 source.

Latest run (2026-10-29, x86_64 container, release builds; resvg's times exclude drawing the
source, and repeat runs vary by about 20%). Every filter is now faster than resvg. The first
run's times are in parentheses:

| Filter | vector ms | resvg ms | ratio | pixels differing by more than 8 |
| --- | ---: | ---: | ---: | ---: |
| blur4 | 6.7 (19.7) | 32.4 | 0.21x | 3.0% |
| blur16 | 6.9 (19.8) | 28.0 | 0.25x | 11% |
| saturate | 2.1 (13.6) | 7.3 | 0.28x | 0% |
| dilate3 | 1.3 (24.0) | 22.4 | 0.06x | 11% |
| gamma | 2.5 (2.7) | 29.8 | 0.08x | 0% |
| sharpen | 7.9 (48.3) | 18.1 | 0.44x | 0% |
| turbulence | 32.2 (116.7) | 77.5 | 0.42x | 0% |
| lighting | 4.8 (17.7) | 14.3 | 0.34x | 0% |
| displace | 2.1 (6.5) | 6.3 | 0.33x | 96% |

Image differences on blur, dilate and displace are resvg's choices (its box sizes, a `2 r` window
and a premultiplied displacement map); `bench/filters/WORKLOADS.md` has the details.

## Choices

- **Coverage on the CPU.** Flattening and coverage are branchy and data dependent; they are cheap
  on the CPU for UI-sized scenes and need no compute shaders, which keeps the browser path and
  lavapipe CI working. Moving coarse rasterization to compute is possible later behind the same
  strip format.
- **Column granularity.** Strips start and end at any column, not at 4-pixel tile edges. This
  emits fewer alpha bytes than tile-aligned strips for thin shapes and keeps solid runs exact.
- **f32 coverage, f64 geometry.** User-space math is f64 so large transforms keep precision;
  device-space lines, area accumulation and image sampling are f32 like the GPU.
- **Antialiasing only by area.** No MSAA. `shape-rendering: crispEdges` can be served later by
  snapping coverage to 0 or 255.
