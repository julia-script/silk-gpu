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
- Cost: layout invariants at conversion boundaries; instruction-count impact has not yet been measured.
- Sites: `webgpu/src/descriptors.silk`, borrowed `*Ref` types in `webgpu/src/resources.silk`.

## LIMITATION-3 — Native Windows target unavailable

- Report: [silk-lang/silk#2542](https://github.com/silk-lang/silk/issues/2542).
- Observed: the minimal `main() -> i32 { return 0 }` package fails with `Unsupported target x86_64-pc-windows-msvc` (exit 2). The release publishes no Windows toolchain asset.
- Impact: native Windows build and runtime acceptance remain blocked, despite the available pinned Dawn Windows library. Platform-specific surface code is not evidence of Windows execution.
- No fallback compiler, local compiler rebuild, or success-skipping Windows CI is used.

## Browser callback ABI

The browser backend uses explicit callback tokens and exported completion functions rather than assuming access to an exported wasm function table. This is an ABI design, **not** a demonstrated compiler limitation: a minimal native-function-pointer invocation compiled successfully to wasm32 on dev.27.
