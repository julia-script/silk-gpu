# Filter CPU workloads

`filter_bench` (Silk, `vector.filter`) and `bench/filters/resvg` (Rust, resvg 0.45.1) apply the
same filter primitives to the same 512 x 512 source: the vector bench's 300 random circles
(`fills` scene seed and formulas, `cx = 512 n, cy = 512 n, r = 4 + 60 n`, color
`(255 n, 255 n, 255 n, 128 + 127 n / 2)`) on a transparent canvas. `filter_bench` writes the
source as `vector-source.rgba`; the resvg program encodes it as `source.png` and draws it with an
`<image>` through a `filterUnits="userSpaceOnUse"` filter covering the canvas, with
`color-interpolation-filters="sRGB"` so no color space conversion is timed. resvg's figure is its
median render time minus the median time of the same image drawn without the filter.

| Workload | Primitive |
| --- | --- |
| blur4 | `feGaussianBlur stdDeviation="4"` |
| blur16 | `feGaussianBlur stdDeviation="16"` |
| saturate | `feColorMatrix type="saturate" values="0.3"` |
| dilate3 | `feMorphology operator="dilate" radius="3"` |
| gamma | `feComponentTransfer`, gamma 1 / 0.5 / 0 on R, G and B |
| sharpen | `feConvolveMatrix order="3" kernelMatrix="0 -1 0 -1 5 -1 0 -1 0" edgeMode="duplicate"` |
| turbulence | `feTurbulence baseFrequency="0.02" numOctaves="4" seed="0" type="turbulence"` |
| lighting | `feDiffuseLighting surfaceScale="3"` with `fePointLight x="150" y="120" z="100"` |
| displace | `feDisplacementMap` of the source by itself, `scale="20"`, R and G channels |

`scripts/bench-filters` prints both timings and how far the images differ. Known semantic
differences, where `vector.filter` follows the spec and browsers:

- blur: resvg derives its three boxes from a different formula than the spec's `d`.
- dilate3: resvg's window is `2 r` wide with an off-center target; browsers and `vector` use `2 r + 1`.
- displace: resvg reads the map premultiplied; the spec computes on non-premultiplied `in2` values.
