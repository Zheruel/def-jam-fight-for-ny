alignas(16) static uint8_t data[BattleMemorySize];
uint8_t observedPage[BattleMemorySize / 4096]{};
static R5900Context registers{};
static PS2Runtime runtime{};
void callBattle(uint32_t target,uint32_t site);

bool PS2Runtime::dispatchGuestBranch(uint8_t*, R5900Context* c, uint32_t target,
        uint32_t site, uint32_t resume, GuestBranchKind kind, const char*) {
    if (kind == GuestBranchKind::Return) return true;
    c->pc = target;
    if (kind == GuestBranchKind::IndirectJump) return false;
    do { callBattle(c->pc,site); } while (c->pc != resume);
    return true;
}
#define API extern "C" __attribute__((visibility("default")))
API uint8_t* battle_pages() { return observedPage; }
API uint8_t* battle_data() { return data; }
API R5900Context* battle_context() { return &registers; }
API uint32_t battle_call(uint32_t target,uint32_t a0,uint32_t a1,uint32_t a2,uint32_t a3) {
    registers.pc = target;
    registers.r[29].halves[0] = 0x1ff0000;
    registers.r[31].halves[0] = 0;
    registers.r[4].halves[0]=a0;
    registers.r[5].halves[0]=a1;
    registers.r[6].halves[0]=a2;
    registers.r[7].halves[0]=a3;
    do { callBattle(registers.pc,0); } while (registers.pc != 0);
    return (uint32_t)registers.r[2].halves[0];
}
