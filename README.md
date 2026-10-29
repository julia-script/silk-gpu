## Implementation selection

The native implementation is **[Dawn v20261027.184652](https://github.com/google/dawn/releases/tag/v20261027.184652)**, commit `106704a9ac3fc21b1580ea85aea302ac17d416f1`. The binding uses the stable [`webgpu.h` schema at `a1dc77409bb2b8bd80540cbf4b8db219e123e909`](https://github.com/webgpu-native/webgpu-headers/tree/a1dc77409bb2b8bd80540cbf4b8db219e123e909), not Dawn's extension API. No implementation is built from source during installation.

### Header compatibility

Compared the pinned stable C header with the actual headers extracted from Dawn's release and [wgpu-native v29.0.1.1](https://github.com/gfx-rs/wgpu-native/releases/tag/v29.0.1.1), using declarations normalized for comments and whitespace:

| Stable declarations | Dawn | wgpu-native |
| --- | --- | --- |
| 92 structures and their fields | Identical | Identical |
| 202 exported function signatures | Identical | Identical |
| 10 callback signatures | Identical | Identical |
| 23 opaque handles and 9 scalar/flag aliases | Identical | Identical |
| 470 enum/flag values | All present, identical | 462 present, identical; 8 absent |

The eight missing wgpu-native values are `WGPUFeatureName_AtomicVec2uMinMax`, `WGPUFeatureName_SubgroupSizeControl`, `WGPUFeatureName_TextureCompressionUnaligned`, `WGPUVertexFormat_Snorm10_10_10_2`, `WGPUWGSLLanguageFeatureName_BufferView`, `WGPUWGSLLanguageFeatureName_FragmentDepth`, `WGPUWGSLLanguageFeatureName_ImmediateAddressSpace`, and `WGPUWGSLLanguageFeatureName_SwizzleAssignment`. Its release schema revision is `673658bc2bd70ec39fc55ebe6bb0173cf6d0a603`.

Dawn includes additional implementation-specific declarations, which are not generated into the standard binding. Matching declarations establishes header compatibility, not GPU feature availability: adapters must still report supported features. Both implementations' release identities and binary SHA-256 hashes are recorded in `toolchains.lock.json`; only Dawn is selected for installation.

### Measured binary installation

These are real downloads and archive extraction measurements on an Apple Silicon macOS workstation on 2026-10-28, **not Linux/Windows execution results or CI timing claims**. Downloads were fetched over the network with `curl`, and SHA-256 was checked against GitHub release asset metadata before extraction. The three downloads ran concurrently; extraction timing excludes checksum calculation.

| Release archive | Bytes | Download | Extraction |
| --- | ---: | ---: | ---: |
| Dawn Linux x86_64 Release | 36,369,054 | 8.422 s | 1.366 s |
| wgpu-native Linux x86_64 Release | 15,962,605 | 2.514 s | 0.196 s |
| Dawn Windows x86_64 Release | 118,553,953 | 34.132 s | 3.695 s |

Dawn macOS arm64 (13,802,697 bytes) and wgpu-native macOS arm64 (13,733,288 bytes) were also downloaded and checksum-verified; their measured extraction times were 0.832 s and 0.159 s respectively. No download time was retained for these two archives. The repository's actual Silk, Dawn, and LLVM installer sequence subsequently completed in 6.03 s on this host, using the existing LLVM 22 installation. That is not a cold LLVM download measurement.

Dawn therefore satisfies the stable-header preference without a large source build. Its published Linux and Windows binaries were fetched and extracted in well under a minute here. Cold CI duration and non-macOS execution still need measurement on their respective hosts; these numbers do not establish the 15-minute CI budget.

### Toolchain and platform prerequisites

All installers require Python 3.12+ and `curl`, install under the repository's ignored `.cache/`, print a single absolute result path on stdout, and fail explicitly for missing platform assets or checksum mismatches. They never modify `~/.silk` and never silently use an older compiler.

```sh
SILK_BIN=$(scripts/install-silk)
export SILK_CLANG=$(scripts/install-llvm)
WEBGPU_HOME=$(scripts/install-webgpu)
"$SILK_BIN/silkc" --version
```

- `install-silk` pins **0.1.0-dev.27+323ceb59e7ee**, verifies the release archive and `native-seed.json`, then checks the extracted `bin/silkc` checksum against the corresponding native seed on every invocation. It prints the compiler's **bin directory**.
- `install-webgpu` pins Dawn's Release archives and prints the **installation root**. macOS has `lib/libwebgpu_dawn.a`; Linux has `lib64/libwebgpu_dawn.a`; Windows has `lib/webgpu_dawn.lib`.
- `install-llvm` accepts a working absolute `SILK_CLANG` pointing to LLVM 22, or discovers Homebrew LLVM / `clang-22`; otherwise it downloads checksum-pinned **LLVM 22.1.8**. It prints the **absolute clang executable path**. Published LLVM archives are large (Linux x86_64: 1,938,859,476 bytes); preinstall LLVM 22 for a short cold gate. The full downloaded distribution includes resource headers and `wasm-ld`; a supplied system toolchain must also provide `wasm-ld` for browser builds.

| Native host | Silk dev.27 release | Dawn release | Current prerequisite |
| --- | --- | --- | --- |
| macOS arm64 | Available | Available | LLVM 22 and Apple SDK |
| macOS x86_64 | Not published | Available | Published native Silk compiler required |
| Linux x86_64 | Available | Available | LLVM 22, C++ runtime, Vulkan loader and GPU driver (lavapipe for headless software rendering) |
| Linux aarch64 | Available | Not published | Matching stable-header Dawn binary required; no implicit switch to wgpu-native |
| Windows x86_64 | Not published | Available | Published native Silk compiler and supported Windows target required; MSVC/Windows SDK for Dawn |
| Windows aarch64 | Not published | Not published | Published Silk and Dawn binaries required |

Dawn's archive labels identify the upstream build runners, not a guaranteed minimum OS version. Cross-platform runtime support is not inferred merely from an archive being present. `toolchains.lock.json` also records available wgpu-native Linux/macOS/Windows binaries for reproducible comparison, not as an automatic fallback.

Dawn is a C++ static archive. Its release CMake metadata specifies Threads on all hosts; Linux additionally needs `dl` and `rt`, and macOS needs CoreFoundation, Foundation, IOSurface, QuartzCore, Cocoa, IOKit, and Metal. Link the host C++ runtime as well. Windows uses the MSVC archive and SDK libraries listed in the release's `lib/cmake/Dawn/DawnTargets.cmake`. No unverified cross-platform build or test success is claimed here.

### Reproducible checks and CI

`python3 scripts/check` is the PR gate: raw bindings, browser glue and embedded
WGSL freshness, `silkc check --workspace`, native lifetime/readback/validation
scenarios, and all six pixel samples. `--skip-native` runs only freshness and
workspace checks; `--browser` adds compiled wasm sample execution. Native
compiles run sequentially. `scripts/test-browser` builds `examples` for
`wasm32-unknown-unknown` and invokes the real browser harness.

The PR workflow uses the explicitly supported
[`ubuntu-26.04` x86_64 runner](https://github.com/actions/runner-images/issues/14747),
not the moving `ubuntu-latest` label. Its [published software inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2604-Readme.md)
lists LLVM **22.1.2**; the [runner provisioning script](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/install-clang.sh)
also installs `lld-22`. `scripts/setup-ci` requires that exact Clang version
and fails on an image change instead of silently downloading a 1.9 GB toolchain.
Silk, Dawn, downloaded LLVM distributions, schema inputs, and download caches
are keyed by platform and lockfile hashes. The preinstalled runner LLVM needs
no separate cache. Every PR job has a **15-minute timeout**; a timeout is failure,
not proof that a cold successful run fits the budget. Hosted-runner timings
have not yet been measured.

Linux tests explicitly select **Mesa lavapipe 26.0.8-1ubuntu0.3**.
`scripts/ci-lock.json` pins the 19,109,714-byte amd64 `.deb` from Ubuntu's
[`20261027T000000Z` snapshot](https://snapshot.ubuntu.com/ubuntu/20261027T000000Z/),
SHA-256 `27db5fa34d50d208b58cc94317b573065329740bb98d0e12b7947b06a9d02a4e`.
The actual package was downloaded and its checksum verified during setup research.
The installer verifies it again, installs its runtime dependencies with apt,
checks the installed version, and sets `VK_DRIVER_FILES`/`VK_ICD_FILENAMES` to
the package's lavapipe ICD. The Mesa binary is fixed; hosted-runner images and
their system dependency packages are not hermetically frozen.

The weekly/manual workflow runs macOS26 arm64 native tests and Linux browser
tests outside the PR budget. Browser provisioning downloads only checksum-pinned
**Playwright 1.64.1** JavaScript packages (including `playwright-core`), never a
browser. It requires the runner's already-installed Chromium and passes its
path through `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Locally, an existing Playwright
installation may be selected with `PLAYWRIGHT_MODULE`; otherwise normal Node
module resolution applies. A missing browser, missing `wasm-ld`, unsupported
WebGPU adapter, or failed pixel comparison is a hard failure, not a skip.

The Windows scheduled job verifies the available Dawn archive, then explicitly
fails when it cannot install a real native Silk compiler. Windows is blocked by
[`silk-lang/silk#2542`](https://github.com/silk-lang/silk/issues/2542), not counted
as successful native coverage. This diagnostic intentionally keeps the
scheduled workflow red until the upstream platform prerequisite is resolved.

## Surfaces and the dev-only GLFW example

`webgpu.surface` accepts host-owned Metal layers, Wayland display/surface pairs,
X11 display/window pairs, Win32 HWND/HINSTANCE pairs, and browser canvas selectors
or ids. Native `SurfaceTarget` constructors are unsafe: the caller must supply
valid handles, keep their owning host object alive, and honor its thread affinity.
Each constructor borrows that owner; safe `Surface.create` borrows the typed
target. `Surface` owns one WebGPU reference, releases it on drop, and explicitly
duplicates it with `dup()`. Surface capability arrays are freed on drop; their
slices cannot outlive their owner. Acquired frames contain an owned safe `Texture`.
Surfaces, duplicated references, and acquired textures participate in their
instance's debug live-handle accounting; release builds erase the counters.
Configuration and resize use a borrowed device and view-format slice without a
per-frame descriptor allocation.

The `examples_window` package is dev-only; neither binding package depends on
GLFW. Install GLFW **3.4 or newer** and `pkg-config` (on macOS, `brew install glfw
pkg-config`), then run:

```sh
scripts/window
scripts/window --release --build-only
```

Alternatively set `GLFW_PREFIX` to an existing GLFW installation root with its
library under `lib/`. The example clears and presents its framebuffer, resizes
with host framebuffer changes, waits while minimized, and closes through the
window close control or Escape. Its raw GLFW registrations use `deferredCallbacks`;
`glfwPollEvents` and `glfwWaitEvents` are marked callback pumps. On macOS the build
script compiles a small Objective-C helper that attaches a view-owned
`CAMetalLayer` and updates its drawable size. Linux uses GLFW's actual selected
Wayland or X11 native handles. The Win32 source uses HWND and HINSTANCE, but the
published Silk compiler/target prerequisite above still applies; source support
is not a claim that Windows builds or runs.

Browser canvas chains live in a separate hand-written backend extension rather
than modifying the pinned generated core schema. Selectors use `querySelector`;
ids use `getElementById`, with host canvas registration available for offscreen
canvases.

## Headless samples and pixel fixtures

`examples/` is the `gpu_examples` package. It runs six 64×64 cases without a
window: render-pass clear, a vertex-buffer triangle, an uploaded RGBA texture
with a nearest sampler, 2,048 storage-buffer instanced rounded rectangles,
compute storage writes plus their rendered visualization, and a 4× MSAA
triangle resolved to a single-sampled texture. No scene renderer is included.

```sh
scripts/test-pixels
scripts/test-pixels --binary /absolute/path/to/gpu_examples
scripts/test-pixels --actual /path/to/browser-or-native-artifacts
python3 -m unittest discover -s tests/pixels -p 'test_*.py'
```

The default command uses the pinned toolchains, builds the sample executable,
runs all six cases, and writes raw RGBA, diagnostic PNGs, and `compute.u32`
under `.cache/pixels/native/`. A directly invoked executable writes the raw
artifacts into its working directory. A validation error, uncaptured error,
device loss, failed readback, or incorrect compute value fails the process.
The compute check compares all 4,096 full-width integers to `3*i+7`; the PNG
visualizes their low two bytes and is not a substitute for the buffer check.
Debug builds also retain an independent diagnostics observer for each sample
and require zero live owned GPU handles after its session is dropped. Release
builds erase these counters; run the default debug pixel command for leak checks.

Small expected PNGs live in `tests/pixels/expected/`. Their independent CPU
oracle uses pixel-space triangle half-planes, rectangle-and-circle membership,
four-color texels, and integer arithmetic—not captured GPU output. Every RGBA
channel has tolerance 2. At most 48 triangle pixels or 128 MSAA pixels may
exceed that tolerance; the other four cases permit none. No edge or alpha
channel is ignored. MSAA uses a standard rotated four-sample reference; other
valid sample patterns still consume the same finite difference budget.

To intentionally regenerate these analytic fixtures, run
`python3 tests/pixels/harness.py --regenerate`. WGSL lives in
`examples/shaders/`; after shader edits run `scripts/embed-shaders`, and use
`scripts/embed-shaders --check` to detect stale embedded source.

Native and wasm use one owned start/poll state machine. The browser exports
`sample_start(index)`, `sample_poll(state)` (0 pending, 1 complete, negative
failure), and `sample_drop(state)`. The host polls from animation frames and
async wake notifications rather than blocking the browser. `sample_output`
kind 0 carries little-endian `u32[width,height]`, kind 1 RGBA bytes, kind 2 the
compute `u32` bytes, and kind 3 UTF-8 diagnostics. The host must copy output
synchronously and drop each state exactly once.

### Browser embedding ABI

`scripts/generate-browser` generates both the dependency-free TypeScript ABI
metadata and `examples/src/generated_webgpu_exports.silk`. An embedding application
must include that generated forwarding module in its **root package**, as the
examples do: Silk intentionally does not export symbols declared only in a
dependency. The root module forwards the ten `webgpu_callback_*` entrypoints and
`webgpu_alloc` / `webgpu_free` to the safe package's host hooks.

The pinned compiler's wasm32 C ABI passes multi-field aggregates indirectly.
Single-scalar records are scalarized: `WGPUFuture { id: u64 }` returns an `i64`
(JavaScript `bigint`), **not** a hidden sret pointer. Generated layout metadata
preserves each field's actual width, including 16-bit sampler anisotropy.
Callback strings use flattened pointer/length pairs; callback tokens are explicit
registry IDs, not wasm function-table indices.

Enter Silk through `WebGPUHost.call`. Browser promises retain JS-owned results
and enqueue completion; only an explicit event pump invokes the exported callback.
Its userdata slot must remain pinned until completion or cancellation, with no
outstanding loan to that slot while pumping. Dropping a pending operation cancels
its host registration before releasing the slot. Allocator exports run
synchronously, never during promise settlement. The browser supports zero-timeout
polling, not blocking `WaitAny`.

The six compiled Silk samples have been exercised in installed Chromium through
`browser/test.mjs`: all PNG comparisons, compute values, validation checks, and
handle/allocation cleanup checks passed. The harness never substitutes JavaScript
implementations of sample rendering.
