"""Shared checked-result, timing and callgrind runner; all artifacts stay local."""
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".cache" / "bench"
WORKLOADS = ("draws", "writes", "binds", "rects10k", "rects100k")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def checked_run(binary, case, n, frames, prefix=()):
    env = dict(os.environ, BENCH_CASE=str(case), BENCH_N=str(n), BENCH_FRAMES=str(frames))
    result = subprocess.run([*map(str, prefix), str(binary)], cwd=ROOT, env=env,
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"benchmark exited {result.returncode}: {binary}\n{result.stdout}\n{result.stderr}")
    rows = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    if len(rows) != 1:
        raise ValueError(f"expected one JSON result from {binary}: {result.stdout}")
    row = rows[0]
    expected_n = (10000 if case == 3 else 100000 if case == 4 else n)
    if (row.get("schema") != 1 or row.get("checked") is not True or
        row.get("workload") != WORKLOADS[case] or row.get("frames") != frames or
        row.get("n") != expected_n or not isinstance(row.get("checksum"), int) or
        not isinstance(row.get("cpu_ns"), int) or row["cpu_ns"] <= 0):
        raise ValueError(f"invalid or unchecked benchmark result: {row}")
    return row


def metadata(binaries):
    return {"schema": 1, "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "host": {"system": platform.system(), "machine": platform.machine(), "platform": platform.platform()},
            "ci": json.loads((ROOT / "scripts/ci-lock.json").read_text()),
            "source_commit": os.environ.get("GITHUB_SHA"),
            "run_url": (f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
                        if os.environ.get("GITHUB_RUN_ID") else None),
            "toolchains": json.loads((ROOT / "toolchains.lock.json").read_text()),
            "rust_lock_sha256": sha(ROOT / "bench/rust/Cargo.lock"),
            "shader_sha256": sha(ROOT / "examples/shaders/instanced-rects.wgsl"),
            "binaries": {name: {"path": str(path), "sha256": sha(path)} for name, path in binaries.items()}}


def measure(binaries, n, frames, repeats):
    output = metadata(binaries)
    output["metric"] = "frame_cpu_ns"
    output["scope"] = "encode/write and submit; excludes setup, GPU wait and checked readback; two warmup frames"
    output["results"] = []
    for case, name in enumerate(WORKLOADS):
        rows = {language: [] for language in binaries}
        checksums = set()
        # Interleave languages to reduce temperature/order drift.
        for repeat in range(repeats):
            order = list(binaries)
            if repeat % 2: order.reverse()
            for language in order:
                row = checked_run(binaries[language], case, n, frames)
                if row["language"] != language: raise ValueError("binary language does not match label")
                checksums.add(row["checksum"])
                rows[language].append(row["cpu_ns"] / frames)
        if len(checksums) != 1: raise ValueError(f"peer checksum mismatch in {name}")
        for language, samples in rows.items():
            output["results"].append({"language": language, "workload": name,
                "n": 10000 if case == 3 else 100000 if case == 4 else n,
                "frames": frames, "checksum": next(iter(checksums)), "checked": True,
                "median": statistics.median(samples), "samples": samples})
    return output


def compare(old, new):
    if old["metric"] != new["metric"]: raise ValueError("cannot compare unlike metrics")
    if old["host"]["system"] != new["host"]["system"] or old["host"]["machine"] != new["host"]["machine"]:
        raise ValueError("cannot compare baselines from different host platforms")
    before = {(r["language"], r["workload"], r["n"]): r for r in old["results"]}
    after = {(r["language"], r["workload"], r["n"]): r for r in new["results"]}
    if before.keys() != after.keys(): raise ValueError("baseline workload matrix differs")
    ratios = []
    for key, row in after.items():
        previous = before[key]
        if not row["checked"] or not previous["checked"] or row["checksum"] != previous["checksum"]:
            raise ValueError(f"unchecked or changed output: {key}")
        ratio = row["median"] / previous["median"]
        ratios.append(ratio)
        print(f"{key[0]:5} {key[1]:12} {ratio:.4f}x ({new['metric']})")
    print(f"geomean {math.exp(statistics.mean(map(math.log, ratios))):.4f}x")


def peer_ratios(data):
    values = {(r["language"], r["workload"]): r["median"] for r in data["results"]}
    for peer in ("c", "rust"):
        if not all((peer, name) in values and ("silk", name) in values for name in WORKLOADS): continue
        ratios = [values["silk", name] / values[peer, name] for name in WORKLOADS]
        for name, ratio in zip(WORKLOADS, ratios): print(f"silk/{peer} {name:12} {ratio:.4f}x")
        print(f"silk/{peer} geomean {math.exp(statistics.mean(map(math.log, ratios))):.4f}x")


def callgrind(binary, case, n, frames, destination):
    prefix = ["valgrind", "--tool=callgrind", "--collect-atstart=no", "--instr-atstart=yes",
              "--error-exitcode=99", f"--callgrind-out-file={destination}"]
    row = checked_run(binary, case, n, frames, prefix)
    if not row["callgrind_markers"]: raise ValueError("rebuild with BENCH_CALLGRIND=1; unmarked runs cannot produce scoped Ir")
    text = destination.read_text()
    events = next(line.split()[1:] for line in text.splitlines() if line.startswith("events:"))
    counts = next(line.split()[1:] for line in text.splitlines() if line.startswith("summary:"))
    ir = int(counts[events.index("Ir")])
    if ir <= 0: raise ValueError("empty Callgrind measured region")
    row["Ir"] = ir
    # Preserve the measured call graph, including allocation call sites. It is evidence
    # for attribution, not a claim that all native backend allocations are wrapper allocations.
    annotated = subprocess.run(["callgrind_annotate", "--inclusive=yes", "--tree=both", "--threshold=100", str(destination)],
                               check=True, capture_output=True, text=True)
    destination.with_suffix(".calls.txt").write_text(annotated.stdout)
    return row
