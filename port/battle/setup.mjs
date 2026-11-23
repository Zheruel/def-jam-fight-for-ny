import { getFighter } from "../assets/combat.mjs";
import inventory from "../../ps2/content/inventory.json" with { type: "json" };
import lineups from "./lineups.json" with { type: "json" };

const venues = new Map(inventory.venues.map(venue => [venue.handle, venue]));

// Positions retain the two components and slot order used by the retail table.
export function createBattleLineup(venueHandle, formation, fighterHandles) {
  const venue = venues.get(venueHandle);
  if (!venue) throw new RangeError("Unknown Battle venue handle");
  const layouts = lineups[venue.file];
  if (!Object.hasOwn(layouts, formation)) throw new RangeError("Missing venue formation");
  const positions = layouts[formation];
  if (!Array.isArray(fighterHandles) || fighterHandles.length !== positions.length) {
    throw new RangeError(`This formation requires ${positions.length} fighters`);
  }

  const participants = positions.map((position, index) => {
    const fighter = getFighter(fighterHandles[index]);
    if (!fighter) throw new RangeError(`Unknown fighter for slot ${index + 1}`);
    return { slot: index + 1, fighter: fighter.handle, model: fighter.model, position: [...position] };
  });
  return { venue: venue.handle, background: venue.file, formation, participants };
}
