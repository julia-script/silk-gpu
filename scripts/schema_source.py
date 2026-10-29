"""Fetch immutable upstream schema inputs; reference sources stay in .cache only."""
import hashlib
import json
import os
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / "scripts/schema-lock.json"


def fetch_sources():
    lock = json.loads(LOCK.read_text())
    directory = ROOT / ".cache" / "webgpu-headers" / lock["revision"]
    directory.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, digest in lock["sha256"].items():
        path = directory / name
        data = path.read_bytes() if path.exists() else None
        if data is None:
            url = f'https://raw.githubusercontent.com/{lock["repository"]}/{lock["revision"]}/{name}'
            request = urllib.request.Request(url, headers={"User-Agent": "silk-gpu-generator"})
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read()
        actual = hashlib.sha256(data).hexdigest()
        if actual != digest:
            raise SystemExit(f"SHA-256 mismatch for {name}: expected {digest}, received {actual}; remove corrupt cache explicitly")
        if not path.exists():
            temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
            temporary.write_bytes(data)
            temporary.replace(path)
        paths[name] = path
    return lock, paths


if __name__ == "__main__":
    _, paths = fetch_sources()
    print(paths["webgpu.yml"].parent)
