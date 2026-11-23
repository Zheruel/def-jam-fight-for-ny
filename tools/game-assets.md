# Game asset package

Build the package from the verified US retail PlayStation 2 image. The builder checks the full source SHA-1 while reading the image in 2 MiB blocks. It publishes the manifest after placing every referenced asset.

```sh
python3 tools/package-game.py private/ps2/reference.iso
python3 tools/package-game.py --verify
```

The default output is `game-assets/` in the repository root. Use `--output DIRECTORY` to choose another destination. A rebuild re-creates the referenced assets and atomically replaces the manifest. The manifest is tracked on `main`. The deployed gzip files are published on the [content branch](https://github.com/Zheruel/def-jam-fight-for-ny/tree/content/ps2-us-v1/blocks).

## Static hosting format

`manifest.json` identifies `def-jam-game-assets-v1`, serial `SLUS-21004` and compression `gzip`. It records the virtual byte stream `size`, the fixed logical `blockSize` of 2,097,152 bytes, and the original `sourceSha1`.

- `blocks[i]` describes the bytes starting at `i * blockSize`. Its decoded length is `min(blockSize, size - i * blockSize)`.
- A `null` entry decodes to a block of zero bytes. A string is the SHA-256 of the decoded block. Fetch that complete asset from `blocks/<sha256>.gz` and check its decoded length and digest. Repeated digests share the same asset file.
- Serve asset bytes as `application/gzip` or `application/octet-stream` with ordinary GET requests. Leave `Content-Encoding` unset because the client decompresses each asset.
- `files` maps each original ISO9660 pathname to its logical `offset` and `bytes`. The fixed block map also preserves filesystem sectors and other bytes outside named file ranges.

Gzip files use a fixed timestamp, omit the original filename, and use the same compression settings across blocks. The manifest uses stable key order. The verifier checks every decoded asset and the SHA-1 of the entire reconstructed byte stream, including the implicit zero blocks.

Run the small round-trip and corruption tests with `python3 -m unittest discover -s tests -p test_package_game.py`.
