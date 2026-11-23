// Retail CPU opponents for seats no person holds.
//
// The original decision code is part of the compiled Battle update and needs no host re-implementation. Per frame
// 0x2dbdd0 runs the AI think routine 0x2f1448 for every actor whose flag +0x937 bit 0 is set, which fills that slot's
// controller block (0x4c3ae0 + 0xb8 * slot: buttons +0x7c, newly pressed +0x80, stick axes +0x84..+0x90) and raises its
// ready word (0x4c4cd0 + 4 * slot). Retail's pad poll (0x1d3680, outside the Battle region) then calls 0x2f1338, which
// copies each ready CPU block into the pad record that the seat's pad index selects (0x4bbfb0 + 32 * index). The
// native tick makes that call itself, so a CPU seat is driven exactly as retail drives it.
//
// A seat's type lives at 0x4bbd38 + 4 * slot (0 person, 1 CPU). Actor creation (0x2eda64..0x2eda78) mirrors it into
// actor +0x937 bit 0. The start data is a snapshot taken after creation, so the match start writes both.
//
// Which seats are CPU is always explicit: the match setup names them, nothing fills an empty seat on its own.

import { fetchPacked } from "../viewer/scene.mjs";

export const TYPE_BASE = 0x4bbd38;
export const PAD_BASE = 0x4bbfb0;
export const PAD_COPY = 0x2f1338;
export const AI_BASE = 0x4c3ae0, AI_STRIDE = 0xb8, AI_READY = 0x4c4cd0;
export const CPU_FLAG = 0x937;
export const AI_TABLE = 0x4c4ce0;
const ACTOR_BASE = 0x4bc170, ACTOR_BYTES = 0x12f8;

// Seat numbers are 0-based. A CPU seat is never the first (the host's) and the seats are the last ones, which is also
// what retail's Free For All does, so every person seat stays contiguous for the room's guests.
export function cpuSeats(seats, count) {
  if (!Number.isInteger(count) || count < 0 || count > seats - 1) throw new RangeError("A match keeps at least one person");
  return Array.from({ length: count }, (_, index) => seats - count + index);
}

// Seat type words for the match start, and the actor flag they mirror (what the actor creation at 0x2eda64 does: bit 0
// of +0x937 follows the type). `fighters[i].cpu` marks seat i.
export function writeSeatTypes(memory, fighters) {
  // The AI decision file ("AI  ", 0x15558 bytes) is loaded to the heap at match setup and 0x4c4ce0 points at it. Every
  // start keeps its capture's own pointer; kernel/cpu-<start>.gz carries the pages of the file at that address.
  fighters.forEach((fighter, slot) => {
    const flag = ACTOR_BASE + slot * ACTOR_BYTES + CPU_FLAG;
    memory.setUint32(TYPE_BASE + 4 * slot, fighter.cpu ? 1 : 0, true);
    memory.setUint8(flag, fighter.cpu ? memory.getUint8(flag) | 1 : memory.getUint8(flag) & ~1);
  });
}

// Retail's pad poll step: hand every ready CPU decision to its pad record.
export function copyDecisions(kernel) {
  kernel.call(PAD_COPY, PAD_BASE, 0, 0, 0);
}

export function neutralPad(memory, address) {
  for (let offset = 0; offset < 24; offset += 4) memory.setUint32(address + offset, 0, true);
}

// A seed is {page, 4096 bytes} records. The CPU data pages the person-only seeds never touched (kernel/cpu-<start file>, one per formation start: the formations' heaps differ) are
// appended to a seed that has CPU seats, without replacing any page it already holds.
export async function withCpuPages(seed, fighters, start) {
  if (!fighters.some(fighter => fighter.cpu)) return seed;
  return mergeCpuPages(seed, await fetchPacked(new URL("../kernel/cpu-" + start, import.meta.url)));
}

export function mergeCpuPages(seed, extra) {
  const have = new Set();
  const view = new DataView(seed);
  for (let at = 0; at < seed.byteLength; at += 4100) have.add(view.getUint32(at, true));
  const more = new DataView(extra);
  const keep = [];
  for (let at = 0; at < extra.byteLength; at += 4100) if (!have.has(more.getUint32(at, true))) keep.push(at);
  const merged = new Uint8Array(seed.byteLength + keep.length * 4100);
  merged.set(new Uint8Array(seed));
  keep.forEach((at, index) => merged.set(new Uint8Array(extra, at, 4100), seed.byteLength + index * 4100));
  return merged.buffer;
}
