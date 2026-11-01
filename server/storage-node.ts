import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { migrateWorld, seedWorld, type World, type WorldStore } from "./world.ts";

// Node-only world persistence: a JSON file at the repo root (same location as before).
const FILE = new URL("../world.json", import.meta.url);

export const nodeStore: WorldStore = {
  save(world: World) {
    writeFileSync(FILE, JSON.stringify(world, null, 2));
  },
};

export function loadWorld(): World {
  if (existsSync(FILE)) {
    return migrateWorld(JSON.parse(readFileSync(FILE, "utf8")) as World);
  }
  const w = seedWorld();
  nodeStore.save(w);
  return w;
}
