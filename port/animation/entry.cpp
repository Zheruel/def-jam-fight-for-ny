// Entry points for the statically compiled retail EAGL character sampler.
#include "abi.hpp"
#include <emscripten/emscripten.h>
using Function = void (*)(uint8_t*, R5900Context*, PS2Runtime*);
struct Entry { uint32_t address, end; Function fn; };
extern const Entry kTable[];

alignas(16) static uint8_t data[PS2_RAM_SIZE];
alignas(16) uint8_t scratchpad[0x4000];
uint8_t readPages[PS2_RAM_SIZE / 4096];
static PS2Runtime runtime;
static R5900Context ctx;
uint32_t watchLow=0, watchHigh=0;
extern "C" void sampler_watch(uint32_t, uint32_t, uint64_t, unsigned) {}
extern "C" void sampler_touch(uint32_t, uint32_t, int) {}
extern "C" void battle_service(uint32_t site, uint32_t target) { battle_fault(site,target); }

static const Entry& routine(uint32_t pc) {
    for (const Entry* entry=kTable;entry->fn;++entry)
        if (pc>=entry->address && pc<entry->end) return *entry;
    battle_fault(ctx.pc,pc);
    __builtin_trap();
}
static void runUntil(uint32_t pc,uint32_t resume) {
    do {
        routine(pc).fn(data,&ctx,&runtime);
        pc=ctx.pc;
    } while(pc!=resume);
}
bool PS2Runtime::dispatchGuestBranch(uint8_t*,R5900Context* c,uint32_t target,uint32_t,uint32_t resume,
                                     GuestBranchKind kind,const char*) {
    if(kind==GuestBranchKind::Return) return true;
    if(kind==GuestBranchKind::IndirectJump || kind==GuestBranchKind::DirectJump) {
        routine(target).fn(data,c,this);
        return false;
    }
    runUntil(target,resume);
    c->pc=resume;
    return true;
}
extern "C" EMSCRIPTEN_KEEPALIVE uint8_t* buffer() { return data; }
extern "C" EMSCRIPTEN_KEEPALIVE uint8_t* pages() { return readPages; }
extern "C" EMSCRIPTEN_KEEPALIVE void resetScratch() { memset(scratchpad,0,sizeof(scratchpad)); }
extern "C" EMSCRIPTEN_KEEPALIVE float invoke(uint32_t address,int a,int b,int c,int d,int e,float f12,float f13) {
    ctx=R5900Context();
    ctx.pc=address;
    ctx.vu0_vf[0]=_mm_set_ps(1,0,0,0);
    SET_GPR_S32((&ctx),4,a);
    SET_GPR_S32((&ctx),5,b);
    SET_GPR_S32((&ctx),6,c);
    SET_GPR_S32((&ctx),7,d);
    SET_GPR_S32((&ctx),8,e);
    SET_GPR_S32((&ctx),29,0x1ff0000);
    ctx.f[12]=f12;
    ctx.f[13]=f13;
    runUntil(address,0);
    return ctx.f[0];
}
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t resultWord() { return GPR_U32((&ctx),2); }
