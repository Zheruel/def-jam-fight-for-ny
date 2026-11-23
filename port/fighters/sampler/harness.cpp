// Offline harness: loads a 32MB EE RAM snapshot and runs recompiled retail functions on it.
//   sampler <ram.bin> <slot> <time> <bank> <clip>   (retail 0x132b48(slot, bank, clip, out, -1, time)); pose bytes -> stdout
#include "abi.hpp"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>

typedef void (*Fn)(uint8_t*, R5900Context*, PS2Runtime*);
struct Entry { uint32_t address; uint32_t end; Fn fn; };
extern const Entry kTable[];

alignas(16) static uint8_t data[PS2_RAM_SIZE];
alignas(16) uint8_t scratchpad[0x4000];
static R5900Context registers{};
static PS2Runtime runtime{};
uint32_t watchLow = 0, watchHigh = 0;
extern "C" void sampler_watch(uint32_t addr, uint32_t pc, uint64_t value, unsigned bytes) {
    fprintf(stderr, "write%u 0x%x <- 0x%llx at pc 0x%x\n", bytes, addr, (unsigned long long)value, pc);
}
static bool verbose = false;
static void setreg(int i, uint64_t v) { registers.r[i] = _mm_set_epi64x(0, (int64_t)v); }
static uint64_t calls = 0;

extern "C" void battle_fault(uint32_t site, uint32_t target) {
    fprintf(stderr, "FAULT pc=0x%x address=0x%x\n", site, target);
    exit(4);
}
extern "C" void battle_service(uint32_t site, uint32_t target) {
    fprintf(stderr, "SERVICE site=0x%x target=0x%x\n", site, target);
    exit(5);
}
extern "C" void sampler_touch(uint32_t addr, uint32_t pc, int write) {
    if (verbose) fprintf(stderr, "scratchpad %s 0x%x at pc 0x%x\n", write ? "write" : "read", addr, pc);
}

static const Entry* owner(uint32_t pc) {
    for (const Entry* e = kTable; e->fn; e++) if (pc >= e->address && pc < e->end) return e;
    return nullptr;
}

// Run `fn`, then keep running the functions that PS2Recomp split off while the code is still branching
// between them (`pc` left at a target that is not the return address).
static void runUntil(Fn fn, R5900Context* c, uint32_t resume) {
    fn(data, c, &runtime);
    while (c->pc != resume) {
        const Entry* e = owner(c->pc);
        if (!e) { fprintf(stderr, "MISSING range 0x%x\n", c->pc); exit(3); }
        if (verbose) fprintf(stderr, "  continue in 0x%x at pc 0x%x\n", e->address, c->pc);
        e->fn(data, c, &runtime);
    }
}

static Fn find(uint32_t target) {
    for (const Entry* e = kTable; e->fn; e++) if (e->address == target) return e->fn;
    return nullptr;
}

bool PS2Runtime::dispatchGuestBranch(uint8_t*, R5900Context* c, uint32_t target, uint32_t site, uint32_t resume,
                                     GuestBranchKind kind, const char*) {
    if (kind == GuestBranchKind::Return) return true;
    Fn fn = find(target);
    if (!fn) {
        fprintf(stderr, "MISSING 0x%x site=0x%x\n", target, site);
        exit(3);
    }
    calls++;
    if (verbose && target == 0x1f77e8) {
        uint32_t a0 = (uint32_t)_mm_cvtsi128_si64(c->r[4]);
        uint32_t s4 = *(uint32_t*)(data + a0 + 0xc);
        fprintf(stderr, "  0x1f77e8 object=0x%x header=0x%x:", a0, s4);
        for (int i = 0; i < 8; i++) fprintf(stderr, " %08x", *(uint32_t*)(data + s4 + 4 * i));
        fprintf(stderr, "\n");
    }
    if (verbose) fprintf(stderr, "call 0x%x from 0x%x a0=%llx a1=%llx a2=%llx a3=%llx\n", target, site, (unsigned long long)_mm_cvtsi128_si64(c->r[4]), (unsigned long long)_mm_cvtsi128_si64(c->r[5]), (unsigned long long)_mm_cvtsi128_si64(c->r[6]), (unsigned long long)_mm_cvtsi128_si64(c->r[7]));
    float tcall = 0; uint32_t qa = 0, qb = 0, qo = 0;
    if (verbose && target == 0x21f688) {
        qb = (uint32_t)_mm_cvtsi128_si64(c->r[4]); qa = (uint32_t)_mm_cvtsi128_si64(c->r[5]); qo = (uint32_t)_mm_cvtsi128_si64(c->r[6]); tcall = c->f[12];
        float* A = (float*)(data + qa); float* B = (float*)(data + qb);
        fprintf(stderr, "  nlerp t=%g a=(%g %g %g %g) b=(%g %g %g %g)\n", tcall, A[0], A[1], A[2], A[3], B[0], B[1], B[2], B[3]);
    }
    uint64_t s1before = (uint64_t)_mm_cvtsi128_si64(c->r[17]);
    if (kind == GuestBranchKind::IndirectJump || kind == GuestBranchKind::DirectJump) { fn(data, c, &runtime); return false; }
    runUntil(fn, c, resume);
    if (verbose && target == 0x21f688) { float* O = (float*)(data + qo); fprintf(stderr, "  nlerp -> (%g %g %g %g)\n", O[0], O[1], O[2], O[3]);
        for (int r : {1, 2, 3, 4, 5, 6, 7, 8}) { float f[4]; memcpy(f, &c->vu0_vf[r], 16); fprintf(stderr, "    vf%d = %g %g %g %g\n", r, f[0], f[1], f[2], f[3]); } }
    if (verbose && s1before != (uint64_t)_mm_cvtsi128_si64(c->r[17])) fprintf(stderr, "  !! s1 clobbered by 0x%x: %llx -> %llx\n", target, (unsigned long long)s1before, (unsigned long long)_mm_cvtsi128_si64(c->r[17]));
    if (kind == GuestBranchKind::IndirectJump || kind == GuestBranchKind::DirectJump) return false;
    c->pc = resume;
    return true;
}

static uint32_t call(uint32_t target) {
    registers.pc = target;
    setreg(31, 0);
    Fn fn = find(target);
    if (!fn) { fprintf(stderr, "MISSING 0x%x root\n", target); exit(3); }
    runUntil(fn, &registers, 0);
    return (uint32_t)_mm_cvtsi128_si64(registers.r[2]);
}

static uint8_t pristine[PS2_RAM_SIZE];

// One query: restore the snapshot, call retail 0x132b48(slot, bank, clip, out, -1, time), return the pose array.
static void sample(uint32_t slot, float time, int bank, int clip, uint8_t* out) {   // out: 94*48 pose bytes + 3 floats root translation + 1 float root yaw (degrees)
    static bool first = true;
    if (first || !getenv("SAMPLER_KEEP")) {   // SAMPLER_KEEP=1: successive queries share engine state like a running game
        memcpy(data, pristine, PS2_RAM_SIZE);
        memset(scratchpad, 0, sizeof(scratchpad));
        first = false;
    }
    uint32_t character = *(uint32_t*)(data + 0x471230 + slot * 4);
    uint32_t destination = *(uint32_t*)(data + character + 0x17c);
    static bool zeroed = false;
    if (!zeroed || !getenv("SAMPLER_KEEP")) { memset(data + destination, 0, 94 * 48); zeroed = true; }   // see what the engine itself writes
    registers = R5900Context();
    registers.vu0_vf[0] = _mm_set_ps(1.0f, 0.0f, 0.0f, 0.0f);   // VU0 vf0 is hard-wired to (0,0,0,1); the recompiled code reads it
    setreg(28, strtoul(getenv("SAMPLER_GP") ? getenv("SAMPLER_GP") : "0", nullptr, 0));
    setreg(29, 0x1ff0000);
    setreg(4, slot);
    setreg(5, bank);
    setreg(6, clip);
    setreg(7, 0x1e10000);
    setreg(8, 0xffffffffffffffffull);
    registers.f[12] = time;
    call(0x132b48);
    setreg(4, slot);
    call(0x132c38);   // 0x1a3208: root yaw of the sampled motion in degrees (used by 0x2e3d10 -> 0x2e1990)
    float yaw = registers.f[0];
    if (getenv("SAMPLER_DEBUG")) {
        for (int o : {0x17c, 0x180, 0x184}) {
            uint32_t a = *(uint32_t*)(data + character + o); int z = 0;
            for (int k = 0; k < 94; k++) { float* q = (float*)(data + a + 48 * k + 16); if (q[0]*q[0]+q[1]*q[1]+q[2]*q[2]+q[3]*q[3] < 0.5f) z++; }
            fprintf(stderr, "t=%g  +0x%x -> 0x%x zeros=%d%s\n", time, o, a, z, a == destination ? " (was destination)" : "");
        }
    }
    memcpy(out, data + destination, 94 * 48);
    memcpy(out + 94 * 48, data + 0x1e10000, 12);
    memcpy(out + 94 * 48 + 12, &yaw, 4);   // 0x132b48 a3: root translation handed to the actor update (0x2e3d10)
}

// Retail duration service 0x132c60(slot, bank, clip): what the actor update uses as a motion's length.
static void duration(uint32_t slot, int bank, int clip, int32_t* whole, float* fraction) {
    memcpy(data, pristine, PS2_RAM_SIZE);
    memset(scratchpad, 0, sizeof(scratchpad));
    registers = R5900Context();
    registers.vu0_vf[0] = _mm_set_ps(1.0f, 0.0f, 0.0f, 0.0f);
    setreg(29, 0x1ff0000);
    setreg(4, slot);
    setreg(5, bank);
    setreg(6, clip);
    *whole = (int32_t)call(0x132c60);
    *fraction = registers.f[0];
}

int main(int argc, char** argv) {
    if (argc < 3) { fprintf(stderr, "usage: sampler ram.bin slot|- time bank clip   (or '-' to read 'slot time bank clip' lines)\n"); return 2; }
    FILE* f = fopen(argv[1], "rb");
    if (!f || fread(pristine, 1, PS2_RAM_SIZE, f) != PS2_RAM_SIZE) { fprintf(stderr, "bad snapshot\n"); return 2; }
    fclose(f);
    verbose = getenv("SAMPLER_TRACE") != nullptr;
    if (getenv("SAMPLER_WATCH")) { watchLow = strtoul(getenv("SAMPLER_WATCH"), nullptr, 0); watchHigh = watchLow + (getenv("SAMPLER_WATCH_LEN") ? strtoul(getenv("SAMPLER_WATCH_LEN"), nullptr, 0) : 4); }
    if (argv[2][0] == 'd') {   // sampler ram.bin dur  < "slot bank clip" lines -> "v0 f0" lines
        unsigned slot; int bank, clip;
        while (scanf("%u %d %d", &slot, &bank, &clip) == 3) {
            int32_t whole; float fraction;
            duration(slot, bank, clip, &whole, &fraction);
            printf("%d %.9g\n", whole, fraction);
        }
        return 0;
    }
    uint8_t out[94 * 48 + 16];
    if (argv[2][0] == '-') {
        unsigned slot; float time; int bank, clip;
        while (scanf("%u %f %d %d", &slot, &time, &bank, &clip) == 4) {
            sample(slot, time, bank, clip, out);
            fwrite(out, 1, sizeof(out), stdout);
        }
    } else {
        sample(atoi(argv[2]), atof(argv[3]), argc > 4 ? atoi(argv[4]) : 0, argc > 5 ? atoi(argv[5]) : 0, out);
        fwrite(out, 1, sizeof(out), stdout);
    }
    fprintf(stderr, "ok calls=%llu\n", (unsigned long long)calls);
    return 0;
}
