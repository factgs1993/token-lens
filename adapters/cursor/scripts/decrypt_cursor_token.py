#!/usr/bin/env python3
"""Decrypt Cursor Electron safeStorage accessToken on Windows and optionally fetch plan usage."""

from __future__ import annotations

import base64
import json
import os
import sqlite3
import struct
import sys
import urllib.parse
import urllib.request
from pathlib import Path

PREFIX = "cursor-safe-storage:v1:"


def state_db() -> Path:
    return Path(os.environ["APPDATA"]) / "Cursor" / "User" / "globalStorage" / "state.vscdb"


def local_state() -> Path:
    return Path(os.environ["APPDATA"]) / "Cursor" / "Local State"


def read_encrypted_token() -> str:
    db = state_db()
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    row = con.execute(
        "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken'"
    ).fetchone()
    con.close()
    if not row or not row[0]:
        raise RuntimeError("cursorAuth/accessToken missing")
    return str(row[0])


def dpapi_unprotect(data: bytes) -> bytes:
    import ctypes
    import ctypes.wintypes as wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32

    blob_in = DATA_BLOB(len(data), ctypes.create_string_buffer(data))
    blob_out = DATA_BLOB()
    if not crypt32.CryptUnprotectData(
        ctypes.byref(blob_in),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(blob_out),
    ):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def aes_gcm_decrypt(key: bytes, nonce: bytes, ciphertext: bytes, tag: bytes) -> bytes:
    # Prefer cryptography if present; else Windows BCrypt via ctypes is heavy —
    # use pure Python only if cryptography available. Fallback: openssl CLI.
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # type: ignore

        return AESGCM(key).decrypt(nonce, ciphertext + tag, None)
    except Exception:
        pass

    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        key_path = Path(tmp) / "key.bin"
        nonce_path = Path(tmp) / "nonce.bin"
        ct_path = Path(tmp) / "ct.bin"
        tag_path = Path(tmp) / "tag.bin"
        out_path = Path(tmp) / "out.bin"
        key_path.write_bytes(key)
        nonce_path.write_bytes(nonce)
        ct_path.write_bytes(ciphertext)
        tag_path.write_bytes(tag)
        # openssl enc -aes-256-gcm needs special handling; use Python 3.11+ if possible
        script = f"""
from pathlib import Path
key=Path(r'{key_path}').read_bytes()
nonce=Path(r'{nonce_path}').read_bytes()
ct=Path(r'{ct_path}').read_bytes()
tag=Path(r'{tag_path}').read_bytes()
try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    Path(r'{out_path}').write_bytes(AESGCM(key).decrypt(nonce, ct+tag, None))
except Exception as e:
    # stdlib has no AESGCM before using pycryptodome
    raise SystemExit('need cryptography: '+str(e))
"""
        raise RuntimeError(
            "Install cryptography (`py -3 -m pip install cryptography`) for AES-GCM decrypt, "
            "or paste WorkosCursorSessionToken into ~/.cursor/token-lens/session.token"
        )


def decrypt_token(encrypted: str) -> str:
    if not encrypted.startswith(PREFIX):
        if encrypted.count(".") >= 2:
            return encrypted
        raise RuntimeError(f"unsupported token format: {encrypted[:40]}")

    blob = base64.b64decode(encrypted[len(PREFIX) :])
    if blob[:3] != b"v10":
        raise RuntimeError(f"expected v10 envelope, got {blob[:4]!r}")

    local = json.loads(local_state().read_text(encoding="utf-8"))
    enc_key = base64.b64decode(local["os_crypt"]["encrypted_key"])
    if enc_key[:5] != b"DPAPI":
        raise RuntimeError("Local State encrypted_key missing DPAPI prefix")
    aes_key = dpapi_unprotect(enc_key[5:])

    nonce = blob[3:15]
    data = blob[15:]
    ciphertext, tag = data[:-16], data[-16:]
    plain = aes_gcm_decrypt(aes_key, nonce, ciphertext, tag)
    return plain.decode("utf-8")


def jwt_sub(token: str) -> str:
    mid = token.split(".")[1]
    mid += "=" * ((4 - len(mid) % 4) % 4)
    payload = json.loads(base64.urlsafe_b64decode(mid.encode("ascii")))
    sub = payload.get("sub")
    if not sub:
        raise RuntimeError("JWT missing sub")
    return str(sub)


def fetch_plan(token: str) -> dict:
    sub = jwt_sub(token)
    cookie = f"{urllib.parse.quote(sub, safe='')}%3A%3A{urllib.parse.quote(token, safe='')}"
    headers = {
        "Cookie": f"WorkosCursorSessionToken={cookie}",
        "Origin": "https://cursor.com",
        "Referer": "https://cursor.com/dashboard",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TokenLens/1.0",
        "Accept": "application/json",
    }
    urls = (
        "https://cursor.com/api/dashboard/get-current-period-usage",
        "https://www.cursor.com/api/dashboard/get-current-period-usage",
        "https://cursor.com/api/usage-summary",
    )
    last_error = None
    for url in urls:
        req = urllib.request.Request(url, data=b"{}", method="POST", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                raw = res.read().decode("utf-8")
                data = json.loads(raw)
                if isinstance(data, dict):
                    return data
        except Exception as exc:  # noqa: BLE001 - try next endpoint
            last_error = exc
            continue
    raise RuntimeError(str(last_error) if last_error else "usage fetch failed")


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "--decrypt"
    encrypted = read_encrypted_token()
    token = decrypt_token(encrypted)
    if mode == "--jwt":
        # Raw JWT only — consumed by plan-usage.cjs. Never log this elsewhere.
        sys.stdout.write(token)
        return 0
    if mode == "--decrypt":
        parts = token.split(".")
        mid = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
        payload = json.loads(base64.urlsafe_b64decode(mid.encode("ascii")))
        print(
            json.dumps(
                {
                    "ok": True,
                    "jwt_parts": len(parts),
                    "has_sub": bool(payload.get("sub")),
                    "sub_head": str(payload.get("sub", ""))[:28],
                }
            )
        )
        return 0
    if mode == "--fetch":
        plan = fetch_plan(token)
        print(json.dumps(plan, ensure_ascii=False))
        return 0
    raise SystemExit(f"unknown mode {mode}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        raise SystemExit(1)
