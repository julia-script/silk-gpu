"""Build executable packages against pinned binaries without machine paths in manifests."""
import os
from pathlib import Path
import platform
import subprocess
import tomllib
import hashlib
import shutil

from _install import ROOT, CACHE


def command_path(script):
    return Path(subprocess.check_output([str(ROOT / "scripts" / script)], text=True).strip())


def quoted(value):
    import json
    return json.dumps(str(value))


def callback_archive(clang, dawn):
    source = ROOT / "webgpu" / "native" / "callbacks.c"
    flags = ["-std=c11", "-O2", "-I", str(dawn / "include")]
    if platform.system() == "Darwin":
        sdk = subprocess.check_output(["xcrun", "--show-sdk-path"], text=True).strip()
        flags += ["-isysroot", sdk, "-mmacosx-version-min=26.0"]
    identity = repr((str(clang), clang.stat().st_mtime_ns, platform.machine(), flags))
    key = hashlib.sha256(source.read_bytes() + identity.encode()).hexdigest()[:20]
    stage = CACHE / "native-callbacks" / key
    archive = stage / "libsilk_webgpu_callbacks.a"
    if not archive.exists():
        stage.mkdir(parents=True, exist_ok=True)
        object_path = stage / f"callbacks-{os.getpid()}.o"
        subprocess.run([str(clang), *flags, "-c", str(source), "-o", str(object_path)], check=True)
        temporary = stage / f"callbacks-{os.getpid()}.a"
        subprocess.run([str(clang.parent / "llvm-ar"), "rcs", str(temporary), str(object_path)], check=True)
        temporary.replace(archive)
        object_path.unlink()
    return archive


def darwin_linker(clang):
    """Keep LLVM's Mach-O driver name through Silk's executable realpath resolution."""
    candidates = (clang.parent / "ld64.lld", Path("/opt/homebrew/opt/lld/bin/ld64.lld"),
                  Path("/usr/local/opt/lld/bin/ld64.lld"))
    source = next((path.resolve() for path in candidates if path.is_file()), None)
    if source is None:
        raise RuntimeError("Native macOS builds require LLVM 22 ld64.lld (install lld alongside clang)")
    identity = repr((str(source), source.stat().st_size, source.stat().st_mtime_ns))
    directory = CACHE / "linker" / hashlib.sha256(identity.encode()).hexdigest()[:20]
    binary_directory = directory / "bin"
    binary_directory.mkdir(parents=True, exist_ok=True)
    # Homebrew LLD uses @executable_path/../lib; preserve that relative layout.
    libraries = source.parent.parent / "lib"
    if libraries.is_dir() and not (directory / "lib").exists():
        (directory / "lib").symlink_to(libraries, target_is_directory=True)
    linker = binary_directory / "ld64.lld"
    if not linker.exists():
        temporary = binary_directory / f"ld64.lld-{os.getpid()}"
        # A symlink resolves to generic `lld`, which cannot infer Mach-O flavor.
        # Copy the unmodified published executable; never patch compiler or linker.
        shutil.copy2(source, temporary)
        temporary.replace(linker)
    version = subprocess.check_output([str(linker), "--version"], text=True)
    if not version.startswith(("LLD 22.", "Homebrew LLD 22.")):
        raise RuntimeError(f"Expected LLVM 22 Mach-O linker, found {version.strip()}")
    return linker


def build(package_path, release=False, extra_links=(), target=None):
    package_path = Path(package_path).resolve()
    if package_path.is_file():
        package_path = package_path.parent
    manifest = tomllib.loads((package_path / "silk.toml").read_text())
    package = manifest["package"]
    compiler_bin = command_path("install-silk")
    clang = command_path("install-llvm")
    stdlib = compiler_bin.parent / "lib" / "silk" / "stdlib"
    wasm = target == "wasm32-unknown-unknown"
    stage = CACHE / "build" / (package["name"] + ("-wasm" if wasm else ""))
    stage.mkdir(parents=True, exist_ok=True)
    source = stage / "src"
    if not source.exists():
        source.symlink_to(package_path / "src", target_is_directory=True)
    elif source.resolve() != (package_path / "src").resolve():
        raise RuntimeError(f"Conflicting staged source: {source}")
    lines = ["[package]"]
    for key, value in package.items():
        if isinstance(value, list):
            lines.append(f"{key} = [" + ", ".join(quoted(v) for v in value) + "]")
        else:
            lines.append(f"{key} = {quoted(value)}")
    lines.extend(["", "[dependencies]"])
    for name, dependency in manifest.get("dependencies", {}).items():
        if set(dependency) != {"path"}:
            raise ValueError(f"Expected a local dependency: {name}")
        lines.append(f"{name} = {{ path = {quoted((package_path / dependency['path']).resolve())} }}")
    links = []
    if not wasm:
        dawn = command_path("install-webgpu")
        if platform.system() == "Darwin":
            links = [{"static-archive": dawn / "lib" / "libwebgpu_dawn.a"}, {"library": "c++", "mode": "dynamic"}]
            links += [{"framework": name} for name in ("CoreFoundation", "Foundation", "IOSurface", "QuartzCore", "Cocoa", "IOKit", "Metal")]
        elif platform.system() == "Linux":
            links = [{"static-archive": dawn / "lib64" / "libwebgpu_dawn.a"}]
            links += [{"library": name, "mode": "dynamic"} for name in ("stdc++", "m", "dl", "rt", "pthread")]
        else:
            raise RuntimeError("The pinned Silk release has no supported native Windows target")
        # Support archives precede Dawn so their WebGPU references resolve with traditional linkers.
        links = list(extra_links) + [{"static-archive": callback_archive(clang, dawn)}] + links
        staged_links = []
        for index, link in enumerate(links):
            link = dict(link)
            for key in ("static-archive", "object", "search-path"):
                if key in link:
                    path = Path(link[key]).resolve()
                    if not path.exists():
                        raise FileNotFoundError(path)
                    name = f"link-{index}" + (path.suffix if path.is_file() else "")
                    local = stage / name
                    if local.is_symlink() and local.resolve() != path:
                        local.unlink()
                    if not local.exists():
                        local.symlink_to(path, target_is_directory=path.is_dir())
                    link[key] = name
            staged_links.append("  { " + ", ".join(f"{key} = {quoted(value)}" for key, value in link.items()) + " }")
        lines.extend(["", "[native]", "link = [", ",\n".join(staged_links), "]"])
        if platform.system() == "Darwin":
            sdk = subprocess.check_output(["xcrun", "--show-sdk-path"], text=True).strip()
            # Apple ld promotes per-object Silk personalities to compact unwind
            # and exceeds its three-personality limit. LLVM preserves DWARF FDEs.
            linker = darwin_linker(clang)
            lines.append('platform-supply = { kind = "explicit", target = "aarch64-apple-darwin", root = ' + quoted(sdk) + ', linker = ' + quoted(linker) + ', origin = "active Xcode SDK with LLVM 22 Mach-O linker" }')
    staged_manifest = stage / "silk.toml"
    staged_manifest.write_text("\n".join(lines) + "\n")
    command = [str(compiler_bin / "silkc"), "build", "--manifest-path", str(staged_manifest), "--stdlib", str(stdlib), "--clang", str(clang)]
    if target:
        command += ["--target", target]
    if release:
        command.append("--release")
    completed = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    print(completed.stdout, end="")
    print(completed.stderr, end="", file=__import__("sys").stderr)
    completed.check_returncode()
    profile = "release" if release else "debug"
    candidates = list((stage / "build" / "llvm").glob(f"*/{profile}/{package['name']}"))
    if len(candidates) != 1:
        raise RuntimeError(f"Expected one built executable under {stage}, found {candidates}")
    return candidates[0]
