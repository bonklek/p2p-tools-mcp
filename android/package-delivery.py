"""Assemble private Android integration artifacts after the native/JS builds pass."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.3.0-alpha.1"
OUT = ROOT / "artifacts" / "android"
NAME = f"p2p-android-{VERSION}"
STAGE = OUT / NAME

def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

OUT.mkdir(parents=True, exist_ok=True)
STAGE.mkdir(exist_ok=True)
runtime = STAGE / "runtime"
runtime.mkdir(exist_ok=True)
for name in ("package.json", "package-lock.json", "LICENSE"):
    shutil.copy2(ROOT / name, runtime / name)
shutil.copytree(ROOT / "dist", runtime / "dist", dirs_exist_ok=True)
subprocess.run(["npm.cmd", "ci", "--omit=dev", "--ignore-scripts", "--prefix", str(runtime)], check=True, cwd=ROOT)
for src, dest in (("android/install-termux.sh", "install-termux.sh"), ("docs/android-device-integration.md", "android-device-integration.md")):
    text = (ROOT / src).read_text(encoding="utf-8").replace("\r\n", "\n")
    (STAGE / dest).write_text(text, encoding="utf-8", newline="\n")
subprocess.run(["node", str(ROOT / "android/verify-mcp.mjs"), str(runtime)], check=True, cwd=ROOT)
files = sorted(p for p in STAGE.rglob("*") if p.is_file() and p.name != "TERMUX-SHA256SUMS")
(STAGE / "TERMUX-SHA256SUMS").write_text("".join(f"{sha(p)}  {p.relative_to(STAGE).as_posix()}\n" for p in files), encoding="utf-8", newline="\n")
archive = OUT / f"{NAME}-termux.tar.gz"
with tarfile.open(archive, "w:gz") as bundle:
    for path in sorted(STAGE.rglob("*")):
        info = bundle.gettarinfo(str(path), f"{NAME}/{path.relative_to(STAGE).as_posix()}")
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        info.mode = 0o700 if path.is_dir() or path.name == "install-termux.sh" else 0o600
        if path.is_file():
            with path.open("rb") as source:
                bundle.addfile(info, source)
        else:
            bundle.addfile(info)
native = ROOT / "android/upstream/SeekerAndroid"
apk = native / "Seeker/bin/Debug/net10.0-android36.0/com.bonklek.p2p.android-Signed.apk"
if not apk.exists():
    raise RuntimeError("Signed APK is missing; build the pinned native backend first")
shutil.copy2(apk, OUT / f"{NAME}-arm64.apk")
source = OUT / f"{NAME}-native-source.zip"
with zipfile.ZipFile(source, "w", zipfile.ZIP_DEFLATED) as bundle:
    for parent, directories, filenames in os.walk(native):
        directories[:] = sorted(d for d in directories if d not in {".git", "bin", "obj", ".vs"})
        for filename in sorted(filenames):
            path = Path(parent) / filename
            bundle.write(path, "SeekerAndroid/" + path.relative_to(native).as_posix())
    for path in sorted((ROOT / "android").glob("*.ps1")):
        bundle.write(path, "p2p-tools-build/" + path.name)
    bundle.write(ROOT / "android/upstream.lock.json", "p2p-tools-build/upstream.lock.json")
    for path in sorted((ROOT / "android/native").glob("*.cs")):
        bundle.write(path, "p2p-tools-build/native/" + path.name)
    bundle.write(ROOT / "docs/android-device-integration.md", "p2p-tools-build/README.md")
shutil.copy2(ROOT / "docs/android-device-integration.md", OUT / "START-HERE.md")
shutil.copy2(ROOT / "docs/android-architecture-plan.md", OUT / "ARCHITECTURE.md")
deliverables = [OUT / f"{NAME}-arm64.apk", archive, source, OUT / "START-HERE.md", OUT / "ARCHITECTURE.md"]
(OUT / "SHA256SUMS").write_text("".join(f"{sha(p)}  {p.name}\n" for p in deliverables), encoding="utf-8", newline="\n")
print(json.dumps({"artifacts": [{"name": p.name, "bytes": p.stat().st_size, "sha256": sha(p)} for p in deliverables]}, indent=2))
