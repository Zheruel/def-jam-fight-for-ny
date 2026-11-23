"""Build and verify static, content-addressed assets from the retail USA PS2 disc."""

import argparse
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory

from disc import SHA1, SIZE, catalog


FORMAT = "def-jam-game-assets-v1"
SERIAL = "SLUS-21004"
BLOCK_SIZE = 2 * 1024 * 1024
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "game-assets"
DEFAULT_WORKERS = min(8, os.cpu_count() or 1)
BLOCK_HASH = re.compile(r"[a-f0-9]{64}")


def write_block(path, data):
    with path.open("wb") as target:
        with gzip.GzipFile(filename="", fileobj=target, mode="wb", compresslevel=6, mtime=0) as archive:
            archive.write(data)
    return path.stat().st_size


def build(source, output, *, expected_size=SIZE, expected_sha1=SHA1, block_size=BLOCK_SIZE,
          files=None, workers=DEFAULT_WORKERS, progress=None):
    """Read the source once and publish the manifest after every asset is in place."""
    output.mkdir(parents=True, exist_ok=True)
    zeros = bytes(block_size)
    source_hash = hashlib.sha1()
    size = 0
    blocks = []
    unique = set()
    compressed_bytes = 0
    pending = deque()

    with TemporaryDirectory(prefix=".package-", dir=output) as temporary:
        staging = Path(temporary)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            while data := source.read(block_size):
                size += len(data)
                if size > expected_size:
                    raise ValueError("Source exceeds the expected disc size.")
                source_hash.update(data)
                if data == zeros[:len(data)]:
                    blocks.append(None)
                else:
                    digest = hashlib.sha256(data).hexdigest()
                    blocks.append(digest)
                    if digest not in unique:
                        unique.add(digest)
                        pending.append(pool.submit(write_block, staging / (digest + ".gz"), data))
                        if len(pending) >= workers * 2:
                            compressed_bytes += pending.popleft().result()
                if progress and len(blocks) % 128 == 0:
                    progress(size, expected_size)
            while pending:
                compressed_bytes += pending.popleft().result()

        if size != expected_size or source_hash.hexdigest() != expected_sha1:
            raise ValueError("Source does not match the expected disc size and SHA-1.")

        manifest = {
            "format": FORMAT,
            "serial": SERIAL,
            "size": size,
            "blockSize": block_size,
            "compression": "gzip",
            "sourceSha1": expected_sha1,
            "blocks": blocks,
        }
        if files is not None:
            manifest["files"] = files
        manifest_path = staging / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")
        assets = output / "blocks"
        assets.mkdir(exist_ok=True)
        for digest in unique:
            filename = digest + ".gz"
            (staging / filename).replace(assets / filename)
        manifest_path.replace(output / "manifest.json")

    return manifest, compressed_bytes


def verify(output, *, expected_size=SIZE, expected_sha1=SHA1, block_size=BLOCK_SIZE):
    """Verify every logical block and the SHA-1 of the decoded byte stream."""
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("Expected a game asset manifest object.")
    if (manifest.get("format"), manifest.get("serial"), manifest.get("compression"),
        manifest.get("size"), manifest.get("sourceSha1"), manifest.get("blockSize")) != (
            FORMAT, SERIAL, "gzip", expected_size, expected_sha1, block_size):
        raise ValueError("Game asset manifest header does not match the expected disc.")
    blocks = manifest.get("blocks")
    if not isinstance(blocks, list) or len(blocks) != (expected_size + block_size - 1) // block_size:
        raise ValueError("Game asset manifest has an invalid block count.")

    source_hash = hashlib.sha1()
    zeros = bytes(block_size)
    compressed_sizes = {}
    for index, digest in enumerate(blocks):
        length = min(block_size, expected_size - index * block_size)
        if digest is None:
            source_hash.update(zeros[:length])
            continue
        if not isinstance(digest, str) or not BLOCK_HASH.fullmatch(digest):
            raise ValueError(f"Invalid asset digest at block {index}.")
        path = output / "blocks" / (digest + ".gz")
        with gzip.open(path, "rb") as archive:
            data = archive.read(length + 1)
        if len(data) != length or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f"Asset data mismatch at block {index} ({digest}).")
        source_hash.update(data)
        if digest not in compressed_sizes:
            compressed_sizes[digest] = path.stat().st_size

    if source_hash.hexdigest() != expected_sha1:
        raise ValueError("Decoded assets do not reproduce the expected disc SHA-1.")
    return manifest, sum(compressed_sizes.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, nargs="?", help="verified retail USA PS2 ISO")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--verify", action="store_true", help="verify an existing package without the source ISO")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help="parallel gzip jobs")
    args = parser.parse_args()
    if args.verify == (args.source is not None):
        parser.error("provide a source ISO to build or use --verify to check an existing package")
    if args.workers < 1:
        parser.error("--workers must be positive")

    try:
        if args.verify:
            manifest, compressed_bytes = verify(args.output)
        else:
            with args.source.open("rb") as source:
                if os.fstat(source.fileno()).st_size != SIZE:
                    raise ValueError("Source size does not match the retail USA PS2 disc.")
                index = catalog(source)
                source.seek(0)
                manifest, compressed_bytes = build(
                    source, args.output, files=index["files"], workers=args.workers,
                    progress=lambda offset, total: print(f"Packaging {offset / total:.0%}", file=sys.stderr, flush=True),
                )
    except (EOFError, KeyError, OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")

    blocks = manifest["blocks"]
    nonzero = [digest for digest in blocks if digest is not None]
    print(f"{'Verified' if args.verify else 'Built'} {SERIAL} in {args.output}")
    print(f"{manifest['size']:,} logical bytes | {compressed_bytes:,} compressed bytes | "
          f"{len(set(nonzero)):,} unique assets | {len(blocks) - len(nonzero):,} zero blocks | "
          f"{len(nonzero) - len(set(nonzero)):,} duplicate blocks")


if __name__ == "__main__":
    main()
