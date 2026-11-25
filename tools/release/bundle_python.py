"""Bundle a pinned, isolated Python for skills into a release payload (ADR-072).

    python tools/release/bundle_python.py --out payload/python [--lock release/python/python.lock.json] [--smoke]

Downloads the python.org embeddable package and the pinned wheels from PyPI, checks
every sha256 against release/python/python.lock.json, and unpacks them. Nothing
downloaded is executed here (no pip, no setup scripts); wheels are plain zips. With
--smoke (Windows only) the bundled python.exe imports openpyxl and pandas and writes
and reads back a small workbook.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

UA = {"User-Agent": "offmanual-release-build"}


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def checked(data: bytes, want: str, what: str) -> bytes:
    got = hashlib.sha256(data).hexdigest()
    if got != want:
        sys.exit(f"{what}: sha256 {got} does not match the pinned {want}")
    return data


def safe_extract(z: zipfile.ZipFile, dest: str) -> None:
    root = os.path.realpath(dest)
    for info in z.infolist():
        name = info.filename
        if name.startswith(("/", "\\")) or ":" in name or ".." in name.replace("\\", "/").split("/"):
            sys.exit(f"refusing archive entry {name!r}")
        target = os.path.realpath(os.path.join(dest, name))
        if not (target == root or target.startswith(root + os.sep)):
            sys.exit(f"refusing archive entry {name!r}")
    z.extractall(dest)


def wheel_url(name: str, version: str, file: str) -> str:
    meta = json.loads(fetch(f"https://pypi.org/pypi/{name}/{version}/json"))
    for u in meta["urls"]:
        if u["filename"] == file:
            return u["url"]
    sys.exit(f"{file} is not published for {name} {version}")


def bundle(lock_path: str, out: str) -> None:
    lock = json.load(open(lock_path, encoding="utf8"))
    if os.path.exists(out) and os.listdir(out):
        sys.exit(f"{out} is not empty")
    os.makedirs(out, exist_ok=True)
    py = lock["python"]
    with tempfile.TemporaryDirectory() as tmp:
        z = os.path.join(tmp, "embed.zip")
        open(z, "wb").write(checked(fetch(py["url"]), py["sha256"], "python embeddable"))
        safe_extract(zipfile.ZipFile(z), out)
    site = os.path.join(out, "Lib", "site-packages")
    os.makedirs(site, exist_ok=True)
    # The ._pth file makes the embeddable Python isolated: only these paths, no user
    # site, no PYTHONPATH. Add our site-packages; leave `import site` off.
    pth = os.path.join(out, py["pth"])
    lines = [l.rstrip("\r\n") for l in open(pth, encoding="utf8")]
    if "Lib\\site-packages" not in lines:
        lines.insert(2, "Lib\\site-packages")
    open(pth, "w", encoding="utf8", newline="\r\n").write("\n".join(lines) + "\n")
    for w in lock["wheels"]:
        data = checked(fetch(wheel_url(w["name"], w["version"], w["file"])), w["sha256"], w["file"])
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, w["file"])
            open(p, "wb").write(data)
            safe_extract(zipfile.ZipFile(p), site)
        print(f"{w['name']} {w['version']} ok")
    print(f"Python {py['version']} bundled in {out}")


SMOKE = r"""
import os, sys, tempfile
import openpyxl, pandas
p = os.path.join(tempfile.mkdtemp(), "BankReco_Test_2026-11.xlsx")
wb = openpyxl.Workbook(); ws = wb.active
ws.append(["Date", "Narration", "Amount"]); ws.append(["01-11-2026", "NEFT", 123456.78])
ws["D2"] = "=C2*2"; wb.save(p)
df = pandas.read_excel(p)
assert list(df.columns) == ["Date", "Narration", "Amount"] and float(df["Amount"][0]) == 123456.78
print("smoke ok: openpyxl", openpyxl.__version__, "pandas", pandas.__version__, "python", sys.version.split()[0])
"""


def smoke(out: str) -> None:
    exe = os.path.join(out, "python.exe")
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
    r = subprocess.run([exe, "-c", SMOKE], env=env, capture_output=True, text=True, timeout=300)
    print(r.stdout, r.stderr)
    if r.returncode != 0:
        sys.exit("bundled Python smoke test failed")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--lock", default=os.path.join("release", "python", "python.lock.json"))
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    bundle(a.lock, a.out)
    if a.smoke:
        smoke(a.out)


if __name__ == "__main__":
    main()
