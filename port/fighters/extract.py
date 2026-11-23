"""Extract skinned fighter models from a local retail ISO.

    python3 port/fighters/extract.py extract private/ps2/reference.iso            # Blaze and Doc
    python3 port/fighters/extract.py extract private/ps2/reference.iso --all --output build/fighters
    python3 port/fighters/extract.py verify  private/ps2/reference.iso            # compare checked-in JSON
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from retail import Disc, model_from_disc, roster  # noqa: E402

DEFAULT_MODELS = ("V2IP_113A", "V2IP_109A")      # Blaze, Doc
FORMAT = "def-jam-fny-fighter-model/1"
DEFAULT_OUTPUT = HERE / "models"


def rounded(values, digits):
    return [round(v, digits) for v in values]


def encode(name: str, model: dict) -> str:
    """Serialize with fixed decimals fine enough to recover every stored 16-bit quantum."""
    counts = {"vertices": len(model["positions"]) // 3, "triangles": len(model["indices"]) // 3,
              "bones": len(model["bones"]), "parts": len(model["parts"])}
    document = {
        "format": FORMAT,
        "name": name,
        "counts": counts,
        "bounds": model["boundingBox"],
        "positionScale": model["positionScale"],
        "positions": rounded(model["positions"], 6),
        "normals": rounded(model["normals"], 4),
        "uvs": rounded(model["uvs"], 12),
        "joints": model["joints"],
        "weights": rounded(model["weights"], 5),
        "indices": model["indices"],
        "parts": [{key: part[key] for key in ("firstVertex", "vertexCount", "firstIndex", "indexCount", "palette")}
                  for part in model["parts"]],
        "bones": [{"name": bone["name"], "parent": bone["parent"],
                   "inverseBind": rounded(bone["inverseBind"], 6), "bindWorld": rounded(bone["bindWorld"], 6)}
                  for bone in model["bones"]],
        "source": model["source"],
    }
    return json.dumps(document, separators=(",", ":"), allow_nan=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("extract", "verify"))
    parser.add_argument("iso", type=Path)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--all", action="store_true", help="every V2IP fighter model")
    args = parser.parse_args()

    disc = Disc(str(args.iso))
    try:
        names = roster(disc) if args.all else list(DEFAULT_MODELS)
        args.output.mkdir(parents=True, exist_ok=True)
        for name in names:
            encoded = encode(name, model_from_disc(disc, name))
            path = args.output / f"{name}.json"
            if args.command == "extract":
                path.write_text(encoded, encoding="utf-8")
            elif path.read_text(encoding="utf-8") != encoded:
                print(f"{path} differs from retail", file=sys.stderr)
                return 1
        if args.command == "extract" and not args.all:
            index = {"format": FORMAT, "models": list(names)}
            (args.output / "index.json").write_text(json.dumps(index, indent=1) + "\n", encoding="utf-8")
    finally:
        disc.close()
    print(f"{args.command}: {len(names)} model(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
