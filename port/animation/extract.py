"""Package the licensed WRES animation objects and their relocations for on-demand loading."""
import argparse
import gzip
import json
from pathlib import Path
import struct
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'port/fighters'))
from animbank import Bank, Disc, clip_names, decompress, read_bank


def word(data, offset):
    return struct.unpack_from('<I', data, offset)[0]


def pack(bank):
    data = bytearray(bank.elf.data)
    relocations = set(bank.elf.local)
    children = {word(data, obj + 12 + 4 * j) for obj in bank.entries
                for j in range(word(data, obj + 8) & 0xffff)}
    for child in children:
        if word(data, child) & 0xffff != 25:
            continue
        if struct.unpack_from('<5I', data, child - 20) != (0, 0, 25, 0, 0):
            raise ValueError('Unexpected EAGL compressed-channel reader')
        struct.pack_into('<I', data, child - 20, 0x3a93a8)
        struct.pack_into('<I', data, child - 8, child)
        relocations.add(child - 8)
    by_label = {name: i for i, name in enumerate(bank.labels)}
    tables = []
    for layout in (('t','s','e'), (None,'d',None), ('p','f'), ('p','h')):
        tables.append(len(data))
        for name in bank.names:
            row = [0]
            for suffix in layout:
                if suffix is None:
                    row.append(0)
                elif suffix in ('e','p'):
                    row.append(by_label.get(name + '_' + suffix, -1))
                else:
                    row.append(by_label[name + '_' + suffix])
            data.extend(struct.pack(f'<{len(row)}i', *row))
        data.extend(bytes(-len(data) % 16))
    header = struct.pack('<4s8I', b'WR01', len(data), len(bank.names), len(relocations),
                         bank.elf.symbol('__AnimationBank:::'), *tables)
    return header + struct.pack(f'<{len(relocations)}I', *sorted(relocations)) + data


def signature_banks(disc):
    archive = '/MOTION/BLAZIN.VIV'

    def member(name):
        data = disc.read(archive, *disc.viv_entry(archive, name))
        return decompress(data) if data.startswith(bytes.fromhex('10fb')) else data

    names = clip_names(member('blazin.mnl'))
    common = json.loads((ROOT / 'port/motion/library.json').read_text())['common']
    if names != common[709:] or len(names) != 164:
        raise ValueError('Signature clips differ from the retail executable')
    for index, name in enumerate(names):
        stem = name.replace('N06I0_', 'N06i0_')  # The disc filenames alone use lowercase i.
        bank = Bank(member(stem + '.ord'), member(stem + '.orl'), [name])
        yield f'special{709 + index}', pack(bank)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('iso')
    parser.add_argument('--output', type=Path, default=HERE / 'banks')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    inventory = json.loads((ROOT / 'ps2/content/inventory.json').read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    disc = Disc(args.iso)
    try:
        def save(stem, payload):
            path = args.output / (stem + '.gz')
            if args.check:
                if gzip.decompress(path.read_bytes()) != payload:
                    raise ValueError(f'{path} differs from disc')
            else:
                path.write_bytes(gzip.compress(payload, mtime=0))

        for number in sorted({f['fighterXml']['coreID'] for f in inventory['fighters']}):
            stem = f'wres{number:03}'
            bank = read_bank(disc, '/MOTION/WRES_ALL.VIV', stem)
            save(stem, pack(bank))
        for stem, payload in signature_banks(disc):
            save(stem, payload)
    finally:
        disc.close()


if __name__ == '__main__':
    main()
