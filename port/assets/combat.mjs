import data from "./combat-data.mjs";

export const { combatTuning, fighters, fightingStyles, source, unassignedBlazin } = data;

const fightersByHandle = new Map(fighters.map(fighter => [Number(fighter.handle), fighter]));

export function getFighter(handle) {
  if (typeof handle === "string" && /^0x[0-9a-f]{1,8}$/i.test(handle)) handle = Number(handle);
  if (!Number.isInteger(handle) || handle < 0 || handle > 0xffffffff) return undefined;
  return fightersByHandle.get((handle & 0xff7fffff) >>> 0);
}
