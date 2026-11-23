// Host side of the offline sampler: guest memory, the scratchpad, and the PS2Runtime surface that
// recompiled code calls. Included by the generated abi.hpp (see build.py) after R5900Context.
#pragma once
extern "C" void battle_fault(uint32_t site, uint32_t target);
extern "C" void sampler_touch(uint32_t addr, uint32_t pc, int write);
extern uint8_t scratchpad[0x4000];
extern uint32_t watchLow, watchHigh;
extern "C" void sampler_watch(uint32_t addr, uint32_t pc, uint64_t value, unsigned bytes);
constexpr uint32_t PS2_RAM_SIZE = 0x02000000;
constexpr uint32_t PS2_RAM_MASK = 0x01ffffff;

class PS2Runtime {
public:
    enum class GuestBranchKind { DirectCall, DirectJump, IndirectCall, IndirectJump, Return };
    bool dispatchGuestBranch(uint8_t*, R5900Context*, uint32_t, uint32_t, uint32_t, GuestBranchKind, const char*);
    bool eeCheckpointDue(uint32_t = 32u) const noexcept { return false; }
    void handleSyscall(uint8_t*, R5900Context* c) { battle_fault(c->pc, 0xfffffff0u); __builtin_trap(); }
    void handleSyscall(uint8_t*, R5900Context* c, uint32_t id) { battle_fault(c->pc, 0xfffffe00u | id); __builtin_trap(); }
    void handleBreak(uint8_t*, R5900Context* c) { battle_fault(c->pc, 0xfffffff1u); __builtin_trap(); }
    // Hardware access (MMIO) is outside the sampler: stop at the exact instruction.
    template <typename T> T load(uint8_t*, R5900Context* c, uint32_t a) { battle_fault(c->pc, a); __builtin_trap(); }
    uint8_t Load8(uint8_t* r, R5900Context* c, uint32_t a) { return load<uint8_t>(r, c, a); }
    uint16_t Load16(uint8_t* r, R5900Context* c, uint32_t a) { return load<uint16_t>(r, c, a); }
    uint32_t Load32(uint8_t* r, R5900Context* c, uint32_t a) { return load<uint32_t>(r, c, a); }
    uint64_t Load64(uint8_t* r, R5900Context* c, uint32_t a) { return load<uint64_t>(r, c, a); }
    void Store8(uint8_t*, R5900Context* c, uint32_t a, uint8_t) { battle_fault(c->pc, a); }
    void Store16(uint8_t*, R5900Context* c, uint32_t a, uint16_t) { battle_fault(c->pc, a); }
    void Store32(uint8_t*, R5900Context* c, uint32_t a, uint32_t) { battle_fault(c->pc, a); }
    void Store64(uint8_t*, R5900Context* c, uint32_t a, uint64_t) { battle_fault(c->pc, a); }
    void handleTrap(uint8_t*, R5900Context* c) { battle_fault(c->pc, 0xfffffff2u); __builtin_trap(); }
};

template <typename T> inline T hostGet(const uint8_t* data, uint32_t addr, uint32_t pc) {
    T value;
    if ((addr >> 28) == 7) { __builtin_memcpy(&value, scratchpad + (addr & 0x3fff), sizeof(T)); sampler_touch(addr, pc, 0); return value; }
    addr &= 0x1fffffffu;
    if (addr > PS2_RAM_SIZE - sizeof(T)) { battle_fault(pc, addr); __builtin_trap(); }
    __builtin_memcpy(&value, data + addr, sizeof(T));
    return value;
}
template <typename T> inline void hostPut(uint8_t* data, uint32_t addr, T value, uint32_t pc) {
    if ((addr >> 28) == 7) { __builtin_memcpy(scratchpad + (addr & 0x3fff), &value, sizeof(T)); sampler_touch(addr, pc, 1); return; }
    addr &= 0x1fffffffu;
    if (addr > PS2_RAM_SIZE - sizeof(T)) { battle_fault(pc, addr); __builtin_trap(); }
    if (addr < watchHigh && addr + sizeof(T) > watchLow) { uint64_t v = 0; __builtin_memcpy(&v, &value, sizeof(T) < 8 ? sizeof(T) : 8); sampler_watch(addr, pc, v, sizeof(T)); }
    __builtin_memcpy(data + addr, &value, sizeof(T));
}
#define READ8(a) hostGet<uint8_t>(rdram, (a), ctx->pc)
#define READ16(a) hostGet<uint16_t>(rdram, (a), ctx->pc)
#define READ32(a) hostGet<uint32_t>(rdram, (a), ctx->pc)
#define READ64(a) hostGet<uint64_t>(rdram, (a), ctx->pc)
#define READ128(a) hostGet<__m128i>(rdram, (a), ctx->pc)
#define WRITE8(a, v) hostPut<uint8_t>(rdram, (a), (v), ctx->pc)
#define WRITE16(a, v) hostPut<uint16_t>(rdram, (a), (v), ctx->pc)
#define WRITE32(a, v) hostPut<uint32_t>(rdram, (a), (v), ctx->pc)
#define WRITE64(a, v) hostPut<uint64_t>(rdram, (a), (v), ctx->pc)
#define WRITE128(a, v) hostPut<__m128i>(rdram, (a), (v), ctx->pc)
#define FAST_READ8 READ8
#define FAST_READ16 READ16
#define FAST_READ32 READ32
#define FAST_READ64 READ64
#define FAST_READ128 READ128
#define FAST_WRITE8 WRITE8
#define FAST_WRITE16 WRITE16
#define FAST_WRITE32 WRITE32
#define FAST_WRITE64 WRITE64
#define FAST_WRITE128 WRITE128
#define ps2TraceGuestWrite(...) ((void)0)
