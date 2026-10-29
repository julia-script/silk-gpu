# Silk limitations

All reproductions below use the published **0.1.0-dev.27+323ceb59e7ee** compiler and standard library. No compiler or standard-library patches are used.

## LIMITATION-1 — Nullable native callback fields

- Report: [silk-lang/silk#2540](https://github.com/silk-lang/silk/issues/2540).
- Observed: assigning a null data pointer to a native function-pointer field fails with SEM0025. Native function-pointer types are nonnullable.
- Workaround: generated callback-info constructors require a real exported function. Device descriptors supply both lost/error callbacks. `WGPUProc` is an opaque nullable address, not an invocable callable.
- Cost: ten callback-info constructors require a callback argument. No CPU performance claim.
- Sites: `scripts/generate`; generated `webgpu_sys/src/generated_webgpu.silk`.

## LIMITATION-2 — Phantom lifetimes in C-layout records

- Report: [silk-lang/silk#2541](https://github.com/silk-lang/silk/issues/2541).
- Observed: `extern "C" struct BufferRef<'a> { handle: ?*mut u8 }` fails with SEM0205.
- Workaround: safe descriptors and borrowed handle-array entries are single-field ordinary wrappers. Direct calls use the raw field's address; array conversions check equal wrapper/raw size and alignment. With one full-size field, equal size establishes offset zero. Borrowed lifetimes remain in the safe type.
- Cost: layout invariants at conversion boundaries. The [label-matched Linux Callgrind run](https://github.com/julia-script/silk-gpu/actions/runs/40797020474) measures aggregate safe-wrapper workloads at 0.596–1.046% above C (0.786% geometric mean; `bench/results/linux-callgrind.json`). The isolated layout-conversion cost is not measured; these whole-region totals do not establish that any particular conversion is free.
- Sites: `webgpu/src/descriptors.silk`, borrowed `*Ref` types in `webgpu/src/resources.silk`.

## LIMITATION-3 — Native Windows target unavailable

- Report: [silk-lang/silk#2542](https://github.com/silk-lang/silk/issues/2542).
- Observed: the minimal `main() -> i32 { return 0 }` package fails with `Unsupported target x86_64-pc-windows-msvc` (exit 2). The release publishes no Windows toolchain asset.
- Impact: native Windows build and runtime acceptance remain blocked, despite the available pinned Dawn Windows library. Platform-specific surface code is not evidence of Windows execution.
- No fallback compiler, local compiler rebuild, or success-skipping Windows CI is used.

## LIMITATION-4 — Mixed callback invocation modes

- Report: [silk-lang/silk#2546](https://github.com/silk-lang/silk/issues/2546), including a standalone reproducer.
- Observed: one foreign declaration cannot combine `deferredCallbacks` and `threadCallbacks`; even disjoint direct callback parameters fail with SEM0187. This is the published dev.27 rule, not an undocumented compiler behavior.
- Workaround: two typed C boundaries. The first writes the spontaneous error callback into the device descriptor under `threadCallbacks`; the second installs the lost callback and requests the device under `deferredCallbacks`. Raw-pointer descriptor traversal remains the binding author's responsibility. No callback is falsely declared immediate or weakened to an untyped address.
- Measured bridge cost: LLVM 22.1.8 `-O2`, macOS arm64, emits 2 instructions for the error setter and 13 for the request bridge including its Dawn call. The latter uses 64 stack bytes and copies the 40-byte completion-info argument; neither helper allocates. These are bridge-body disassembly counts, not caller-inclusive Ir or wall-time overhead. Both run once per device request, outside frame hot loops.
- Sites: `webgpu/src/runtime.silk`, `webgpu/native/callbacks.c`, `scripts/_build.py`.

## LIMITATION-5 — Apple linker compact-unwind personality limit

- Report: [silk-lang/silk#2547](https://github.com/silk-lang/silk/issues/2547).
- Observed: the macOS26 hosted ABI executable link fails with 25 distinct internal `___silk_foreign_personality` routines plus Dawn's C++ personality, exceeding the compact-unwind format's three-personality limit. A two-line standalone `getpid` package retains 25 internal personality symbols; its reduced link succeeds on the older local Apple ld 1167.4.1, so the upstream report distinguishes the reduced duplication evidence from the observed hosted link failure.
- Workaround: use unmodified LLVM 22 `ld64.lld`, which preserves the Silk DWARF FDEs rather than promoting their personalities into the compact table. No foreign-unwind guards or unwind metadata are disabled. Silk resolves linker symlinks to generic `lld`, so the build helper caches an unchanged executable named `ld64.lld` with the original library-directory layout.
- Measured: local LLD-linked ABI probe passes all 92 record layouts and 202 linked symbols; the native Metal ownership/mapping/validation/cancellation test passes in 2.05 seconds. Hosted results are recorded separately in CI; no instruction-count overhead claim.
- Site: `scripts/_build.py:darwin_linker`.

## LIMITATION-6 — Float-to-integer conversions run a software trunc (fixed in dev.29)

- Report: [silk-lang/silk#2561](https://github.com/silk-lang/silk/issues/2561), fixed by silk#2562 in dev.29.
- Observed on dev.27: on baseline x86-64 (SSE2), every stdlib `f32`/`f64` to integer conversion and `floor`/`ceil` ran a software trunc before its range check, about 25 extra instructions per call.
- Status: the local `truncateToU8`, `truncateF64ToU8`, `truncateToI64`, `floorF64` and `floorF32` helpers are gone; the stdlib conversions measure the same (filter bench 11.71 G Ir either way, vector bench +0.1%). The rasterizer still truncates non-negative values to `u32` directly where it needs a floor.

## LIMITATION-7 — `f32.min`/`f32.max` compile to branch chains

- Report: [silk-lang/silk#2566](https://github.com/silk-lang/silk/issues/2566).
- Observed: the stdlib's NaN- and signed-zero-ordering `min`/`max` cost 16 Ir per clamp against 3 for plain selects (`minss`/`maxss`). silk#2567 (dev.29) brings that to 7.9 Ir; swapping the helpers for `f32.min`/`f32.max` still adds 0.5% Ir to the vector bench, so they stay.
- Workaround: `vector/src/strips.silk` and `vector/src/paint.silk` use select-based `minF32`/`maxF32`; its lines are always finite, so the values are the same. Measured with the faster float-to-u32 conversions in the same change: on the icons benchmark `Rasterizer.fill` went from 1.42 G to 1.25 G Ir and `pushClipped` from 131 M to 68 M, with byte-identical output.
- Sites: `vector/src/strips.silk`, `vector/src/paint.silk`.

## LIMITATION-8 — Portable inverse tangent missing

- Report: [silk-lang/silk#2539](https://github.com/silk-lang/silk/issues/2539).
- Observed: `f64.atan2(y, x)` fails with SEM0014 on dev.27. Curvature-based circular-bisector stroke clipping requires its signed angle.
- Workaround: a range-reduced alternating series with 24 terms, private to `vector/src/stroke_arcs.silk`; no libc dependency or compiler/stdlib patch.
- Verification: all curvature-join regression cases pass, including asymmetric circles, mixed line/circle joins and circular-bisector arclength clipping. Instruction cost has not yet been measured.

## Browser callback ABI

The browser backend uses explicit callback tokens and exported completion functions rather than assuming access to an exported wasm function table. This is an ABI design, **not** a demonstrated compiler limitation: a minimal native-function-pointer invocation compiled successfully to wasm32 on dev.27.
