"""Compact consecutive samples of action selection from the headless reference match."""
import argparse
import hashlib
import json
from pathlib import Path


def compact(run):
    report = json.loads((run / "report.json").read_text())
    raw = (run / "combat-trace.json").read_bytes()
    samples = json.loads(raw)["samples"]
    first = samples[0]["blank"]
    models = [a["modelIndex"] for a in samples[0]["actors"]]
    actors = [[] for _ in models]
    previous = [None] * len(models)
    for tick, sample in enumerate(samples):
        if sample["blank"] != first + tick:
            raise ValueError("Incomplete VBlank sequence")
        for i, a in enumerate(sample["actors"]):
            if a["slot"] != i or a["modelIndex"] != models[i]:
                raise ValueError("Fighter slot changed")
            selection = [a[k] for k in ("action", "bank", "local", "motion")]
            if selection != previous[i]:
                actors[i].append([tick, *selection])
                previous[i] = selection
    return dict(match=report["match"], wasmSha256=report["wasmSha256"],
                traceSha256=hashlib.sha256(raw).hexdigest(), startBlank=first,
                samples=len(samples), modelIndices=models, transitions=actors)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    args = parser.parse_args()
    print(json.dumps(compact(args.run), indent=2))
