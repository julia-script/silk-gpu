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

### Raw binding gate

Run `python3 scripts/check` to install and verify the pinned Silk, LLVM and Dawn binaries and fetch checksum-verified upstream schema inputs. The workspace contains the generated `webgpu_sys` package and the `native_tests` executable. The Ubuntu26 PR job provisions pinned lavapipe and validates its existing LLVM22 installation before running this gate, with a 15-minute timeout. Hosted timing evidence is recorded in the pull request after execution.

The gate also checks generated binding freshness, checks the workspace, and creates, processes events on, and releases a native Dawn instance. `scripts/generate --check` validates generated declarations and ABI metadata against the pinned schema.
