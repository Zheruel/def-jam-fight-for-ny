import sys,struct as s
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'geometry'))
from foundation import Disc,decompress,c_string
def elf(b):
    ss=list(s.iter_unpack('<10I',b[s.unpack_from('<I',b,32)[0]:]))
    def get(i): return b[ss[i][4]:ss[i][4]+ss[i][5]]
    names=get(s.unpack_from('<H',b,50)[0])
    ns={c_string(names,x[0]):i for i,x in enumerate(ss)}
    st=ns['.symtab']
    names=get(ss[st][6])
    sym=[(c_string(names,n),v,z,i) for n,v,z,f,o,i in s.iter_unpack('<IIIBBH',get(st))]
    return sym,ns,get
def model(m):
    a='/ASSETS/V2IP.VIV'
    with_disc=Disc('private/ps2-battle/reference.iso' if Path('private/ps2-battle/reference.iso').exists() else next(str(p) for p in Path('private').glob('**/*.iso') if p.name != 'reference.iso' or p.parent.name != 'private'))
    entry=with_disc.viv_entry(a,m+'.o')
    return elf(decompress(with_disc.read(a,*entry)))
if __name__=='__main__':
    sym,ns,get=model(sys.argv[1])
    d=get(ns['.data'])
    print(ns, len(d))
    for n,v,z,i in sym:
        if n: print(f'{v:06x} {z:06x} {i:3}',n)
