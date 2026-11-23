// Standalone ABI for statically compiled AKI Battle functions.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <limits.h>

using Quad = uint32_t __attribute__((vector_size(16)));
struct R5900Context {
    union Register { Quad words; uint64_t halves[2]; } r[32];
    float f[32];
    uint64_t hi, lo;
    uint32_t pc, fcr31, branch_pc;
    bool in_delay_slot;
};

extern "C" void battle_fault(uint32_t site, uint32_t target);
extern "C" void battle_service(uint32_t site, uint32_t target);
extern "C" void* memcpy(void*, const void*, size_t);
namespace std { using ::memcpy; }

struct PS2Runtime {
    enum class GuestBranchKind { DirectCall, IndirectCall, IndirectJump, Return };
    bool dispatchGuestBranch(uint8_t*, R5900Context*, uint32_t, uint32_t, uint32_t, GuestBranchKind, const char*);
    bool eeCheckpointDue() const { return false; }
    void handleBreak(uint8_t*, R5900Context* ctx) { battle_fault(ctx->pc,0); __builtin_trap(); }
};

// The Battle library only accesses game data and its stack. Hardware registers
// are outside this ABI. Bad pointers stop at the exact calling instruction.
constexpr uint32_t BattleMemorySize = 0x02000000;
extern uint8_t observedPage[BattleMemorySize / 4096];
inline void track(uint32_t addr, unsigned size) {
#ifdef BATTLE_TRACK_PAGES
    observedPage[addr >> 12] = 1;
    observedPage[(addr+size-1) >> 12] = 1;
#endif
}
template <typename T> T get(const uint8_t* data, uint32_t addr, uint32_t pc) {
    if (addr > BattleMemorySize - sizeof(T)) { battle_fault(pc,addr); __builtin_trap(); }
    track(addr,sizeof(T));
    T value;
    __builtin_memcpy(&value,data+addr,sizeof(T));
    return value;
}
template <typename T> void put(uint8_t* data, uint32_t addr, T value, uint32_t pc) {
    if (addr > BattleMemorySize - sizeof(T)) { battle_fault(pc,addr); __builtin_trap(); }
    track(addr,sizeof(T));
    __builtin_memcpy(data+addr,&value,sizeof(T));
}

#define READ8(a) get<uint8_t>(rdram,(a),ctx->pc)
#define READ16(a) get<uint16_t>(rdram,(a),ctx->pc)
#define READ32(a) get<uint32_t>(rdram,(a),ctx->pc)
#define READ64(a) get<uint64_t>(rdram,(a),ctx->pc)
#define READ128(a) get<Quad>(rdram,(a),ctx->pc)
#define WRITE8(a,v) put<uint8_t>(rdram,(a),(v),ctx->pc)
#define WRITE16(a,v) put<uint16_t>(rdram,(a),(v),ctx->pc)
#define WRITE32(a,v) put<uint32_t>(rdram,(a),(v),ctx->pc)
#define WRITE64(a,v) put<uint64_t>(rdram,(a),(v),ctx->pc)
#define WRITE128(a,v) put<Quad>(rdram,(a),(v),ctx->pc)
#define FAST_READ8 READ8
#define FAST_READ16 READ16
#define FAST_READ32 READ32
#define FAST_READ64 READ64
#define FAST_WRITE8 WRITE8
#define FAST_WRITE16 WRITE16
#define FAST_WRITE32 WRITE32

#define GPR_U64(c,i) ((i)==0 ? 0ull : (c)->r[i].halves[0])
#define GPR_S64(c,i) ((int64_t)GPR_U64(c,i))
#define GPR_U32(c,i) ((uint32_t)GPR_U64(c,i))
#define GPR_S32(c,i) ((int32_t)GPR_U32(c,i))
#define GPR_VEC(c,i) ((i)==0 ? Quad{} : (c)->r[i].words)
#define SET_GPR_U64(c,i,v) do { if ((i)!=0) (c)->r[i].halves[0]=(uint64_t)(v); } while (0)
#define SET_GPR_S64 SET_GPR_U64
#define SET_GPR_S32(c,i,v) SET_GPR_U64(c,i,(int64_t)(int32_t)(v))
#define SET_GPR_U32 SET_GPR_S32
#define SET_GPR_ZE32(c,i,v) SET_GPR_U64(c,i,(uint32_t)(v))
#define SET_GPR_VEC(c,i,v) do { if ((i)!=0) (c)->r[i].words=(v); } while (0)
#define ADD32(a,b) ((uint32_t)(a)+(uint32_t)(b))
#define SUB32(a,b) ((uint32_t)(a)-(uint32_t)(b))
#define SLL32(a,b) ((uint32_t)(a)<<((b)&31))
#define SRL32(a,b) ((uint32_t)(a)>>((b)&31))
#define SRA32(a,b) ((int32_t)(a)>>((b)&31))
inline uint64_t Ps2SignExt32ToU64(uint32_t n) { return (int64_t)(int32_t)n; }
inline uint64_t Ps2HiLoToU64(uint64_t hi,uint64_t lo) { return (hi<<32) | (uint32_t)lo; }
using PackedBytes = uint8_t __attribute__((vector_size(16)));
inline Quad PS2_PCPYLD(Quad a,Quad b) { return {b[0],b[1],a[0],a[1]}; }
inline Quad _mm_unpackhi_epi64(Quad a,Quad b) { return {a[2],a[3],b[2],b[3]}; }
inline Quad PS2_PSUBB(Quad a,Quad b) { return (Quad)((PackedBytes)a - (PackedBytes)b); }
inline Quad PS2_PSUBW(Quad a,Quad b) { return a-b; }
inline Quad PS2_PNOR(Quad a,Quad b) { return ~(a|b); }
inline Quad PS2_PAND(Quad a,Quad b) { return a&b; }
inline Quad PS2_PEXTLW(Quad a,Quad b) { return {b[0],a[0],b[1],a[1]}; }

#define FPU_ADD_S(a,b) ((a)+(b))
#define FPU_SUB_S(a,b) ((a)-(b))
#define FPU_MUL_S(a,b) ((a)*(b))
#define FPU_DIV_S(a,b) ((a)/(b))
#define FPU_ABS_S(a) __builtin_fabsf(a)
#define FPU_SQRT_S(a) __builtin_sqrtf(__builtin_fabsf(a))
#define FPU_MOV_S(a) (a)
#define FPU_NEG_S(a) (-(a))
#define FPU_C_EQ_S(a,b) ((a)==(b))
#define FPU_C_OLE_S(a,b) ((a)<=(b))
#define FPU_C_OLT_S(a,b) ((a)<(b))
#define FPU_CVT_S_W(a) ((float)(int32_t)(a))
#define FPU_CVT_W_S(a) ((int32_t)__builtin_truncf(a))

// These are the four packed operations used by the combat library.
using __m128i = Quad;
inline Quad _mm_set1_epi32(int n) { auto x=(uint32_t)n; return {x,x,x,x}; }
inline Quad _mm_srli_epi32(Quad a,int bits) { return a >> bits; }
inline Quad _mm_and_si128(Quad a,Quad b) { return a & b; }
inline Quad _mm_or_si128(Quad a,Quad b) { return a | b; }
inline uint32_t ps2_plzcw32(uint32_t n) {
    uint32_t significant = (n & 0x80000000u) ? ~n : n;
    return significant ? __builtin_clz(significant)-1 : 31;
}
#define ps2TraceGuestWrite(...) ((void)0)
