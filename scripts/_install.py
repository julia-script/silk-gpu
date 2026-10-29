"""Shared, checksum-pinned binary installation. Requires Python 3.12+ and curl."""
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
LOCK = json.loads((ROOT / "toolchains.lock.json").read_text())


def fail(message):
    raise SystemExit(message)


def target():
    machine = platform.machine().lower()
    arch = {"arm64": "aarch64", "aarch64": "aarch64", "amd64": "x86_64", "x86_64": "x86_64"}.get(machine)
    system = {"Darwin": "apple-darwin", "Linux": "unknown-linux-gnu", "Windows": "pc-windows-msvc"}.get(platform.system())
    if not arch or not system:
        fail(f"Unsupported native platform: {platform.system()} {machine}")
    return f"{arch}-{system}"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(asset):
    directory = CACHE / "downloads"
    directory.mkdir(parents=True, exist_ok=True)
    name = unquote(Path(urlparse(asset["url"]).path).name)
    path = directory / name
    if path.is_file() and digest(path) == asset["sha256"]:
        return path
    # A unique temporary file prevents partial downloads from becoming cache hits.
    with tempfile.TemporaryDirectory(dir=directory) as temporary:
        pending = Path(temporary) / name
        subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "3", "--output", str(pending), asset["url"]], check=True)
        if digest(pending) != asset["sha256"]:
            fail(f"SHA-256 mismatch: {name}")
        pending.replace(path)
    return path


def asset_for(component):
    native = target()
    asset = LOCK[component]["platforms"].get(native)
    if asset is None:
        fail(f"No pinned {component} binary for {native}; see README platform prerequisites. No source build or fallback compiler is attempted.")
    return native, asset


def extract(asset, destination):
    archive = download(asset)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        staging = Path(temporary)
        with tarfile.open(archive) as source:
            source.extractall(staging, filter="data")
        entries = list(staging.iterdir())
        if len(entries) != 1 or not entries[0].is_dir():
            fail(f"Expected one release directory in {archive.name}")
        if destination.exists():
            fail(f"Incomplete installation at {destination}; remove it and retry")
        entries[0].replace(destination)
    return destination


def install(component, destination, required):
    _, asset = asset_for(component)
    marker = destination / ".silk-gpu-archive-sha256"
    if destination.is_dir():
        if not marker.is_file() or marker.read_text().strip() != asset["sha256"]:
            fail(f"Unverified installation at {destination}; remove it and retry")
    else:
        extract(asset, destination)
        marker.write_text(asset["sha256"] + "\n")
    if not (destination / required).is_file():
        fail(f"Release lacks required file: {destination / required}")
    return destination
