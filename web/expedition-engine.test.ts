import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Expedition, generateExpeditionLayout, EXP_W, EXP_H,
  type CrewMember,
} from "./expedition-engine.ts";

const CREW: CrewMember[] = [
  { id: "a", name: "Pip", color: "#ff7a59" },
  { id: "b", name: "Marlo", color: "#4a90d9" },
  { id: "c", name: "Juniper", color: "#b36bd6" },
  { id: "d", name: "Gus", color: "#3fb57a" },
];

function run(p: Expedition, maxSeconds = 900): number {
  let t = 0;
  const dt = 0.05;
  while (t < maxSeconds && p.status === "running") { p.tick(dt); t += dt; }
  return t;
}

test("layout: ridge splits the island, one hidden pass opposite the detour", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const l = generateExpeditionLayout(seed);
    assert.ok(l.rx0 >= 10 && l.rx1 === l.rx0 + 1, `seed ${seed} ridge columns`);
    assert.ok(l.rx1 < EXP_W - 3, `seed ${seed} room east of ridge`);
    if (l.detourTop) {
      assert.equal(l.ridgeTop, 2, `seed ${seed} top detour leaves rows 0-1 open`);
      assert.ok(l.passY >= 9 && l.passY <= 12, `seed ${seed} pass in bottom half, away from camp line`);
    } else {
      assert.equal(l.ridgeBottom, EXP_H - 3, `seed ${seed} bottom detour leaves last rows open`);
      assert.ok(l.passY >= 2 && l.passY <= 5, `seed ${seed} pass in top half`);
    }
    assert.equal(l.crates.length, 4);
    for (const c of l.crates) assert.ok(c.home.x > l.rx1, `seed ${seed} ${c.id} east of ridge`);
    assert.ok(l.camp.x < l.rx0, `seed ${seed} camp west of ridge`);
    assert.equal(l.spawns.length, 4);
    for (const s of l.spawns) assert.ok(s.x < l.rx0, `seed ${seed} spawn west of ridge`);
  }
  assert.deepEqual(generateExpeditionLayout(99), generateExpeditionLayout(99), "deterministic");
});

test("knowledge gates reachability: pass blocked until known, detour always open", () => {
  const p = new Expedition(CREW, 7);
  const l = p.layout;
  // pass tiles are impassable for everyone at the start
  for (const m of p.members) {
    assert.equal(p.walkableFor(m.id, l.rx0 + 0.5, l.passY + 0.5), false);
    assert.equal(p.walkableFor(m.id, l.rx1 + 0.5, l.passY + 0.5), false);
  }
  // but the crates are still reachable the long way, from camp
  const m0 = p.members[0];
  const longRoute = p.pathFor(m0.id, m0.pos, { x: 21.5, y: 7.5 });
  assert.ok(longRoute, "long route exists without any knowledge");
  assert.ok(!longRoute!.some((pt) => Math.floor(pt.x) >= l.rx0 && Math.floor(pt.x) <= l.rx1 && Math.floor(pt.y) === l.passY),
    "long route does not secretly use the pass");
  // once the member knows, the pass opens and the route through it is shorter
  (p as unknown as { discovered: Set<string> }).discovered.add(m0.id);
  const shortRoute = p.pathFor(m0.id, m0.pos, { x: 21.5, y: 7.5 });
  assert.ok(shortRoute, "route exists with knowledge");
  const usesPass = shortRoute!.some((pt) => Math.floor(pt.x) >= l.rx0 && Math.floor(pt.x) <= l.rx1 && Math.floor(pt.y) === l.passY);
  assert.ok(usesPass, "known route goes through the pass");
  const len = (path: { x: number; y: number }[]) => path.reduce((acc, pt, i) => acc + (i ? Math.hypot(pt.x - path[i - 1].x, pt.y - path[i - 1].y) : 0), 0);
  assert.ok(len(shortRoute!) < len(longRoute!), `pass route (${len(shortRoute!).toFixed(1)}) shorter than detour (${len(longRoute!).toFixed(1)})`);
  // others still cannot use it
  assert.equal(p.walkableFor(p.members[1].id, l.rx0 + 0.5, l.passY + 0.5), false);
});

test("built-in crew completes via the detour and never discovers the pass by accident", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const p = new Expedition(CREW, seed);
    const t = run(p);
    assert.equal(p.status, "complete", `seed ${seed} stalled at ${t}s with ${p.deliveredCount()}/4`);
    const s = p.snapshot();
    assert.equal(s.stats.discoveries.length, 0, `seed ${seed}: errand running accidentally found the pass`);
    assert.equal(s.stats.shares.length, 0);
    assert.equal(s.pass.foundByAnyone, false, `seed ${seed}: pass revealed without scouting`);
  }
});

test("scouting discovers the pass privately; sharing propagates it", () => {
  const p = new Expedition(CREW, 7);
  const a = p.members[0];
  // nobody knows anything at the start
  assert.equal(p.decisionViewFor(a.id).passIKnow, null);
  assert.equal(p.canScout(a.id), true);
  // scout until the pass is found
  let found = false;
  for (let trip = 0; trip < 6 && !found; trip++) {
    const res = p.applyDecision(a.id, { action: "scout", reason: "looking" });
    assert.ok(res.ok, res.why);
    let t = 0;
    while (t < 60 && a.state === "scouting") { p.tick(0.05); t += 0.05; }
    found = p.decisionViewFor(a.id).iFoundUnshared !== null;
  }
  assert.ok(found, "scouting found the pass");
  // private: only Pip knows
  assert.deepEqual(p.snapshot().pass.knownBy, ["Pip"]);
  assert.equal(p.decisionViewFor(p.members[1].id).passIKnow, null);
  assert.ok(!p.canScout(a.id), "nothing left to scout for the discoverer");
  // share: now everyone knows, credited to Pip
  const res = p.applyDecision(a.id, { action: "share", reason: "telling everyone" });
  assert.ok(res.ok, res.why);
  const s = p.snapshot();
  assert.equal(s.pass.sharedBy, "Pip");
  assert.equal(s.pass.knownBy.length, 4);
  assert.equal(p.decisionViewFor(p.members[1].id).passIKnow?.foundBy, "Pip");
  assert.ok(s.log.some((l) => l.text.includes("shared the hidden pass")));
});

test("a mid-fetch member's route is automatically re-planned after a share (and the feed says so)", () => {
  const p = new Expedition(CREW, 7);
  const [a, b] = p.members;
  // Marlo sets out on an errand first (long route, no knowledge)
  const f = p.applyDecision(b.id, { action: "fetch", crate: "crate-0", reason: "fetching" });
  assert.ok(f.ok, f.why);
  for (let i = 0; i < 3; i++) p.tick(0.05); // 0.15s: en route, before any dispatch
  assert.equal(b.state, "fetching");
  const l = p.layout;
  const usesPassNow = b.path.some((pt) => Math.floor(pt.y) === l.passY && Math.floor(pt.x) >= l.rx0 && Math.floor(pt.x) <= l.rx1);
  assert.ok(!usesPassNow, "Marlo is on the long route before the share");
  // Pip finds and shares the pass while Marlo is en route
  for (let trip = 0; trip < 6 && !p.decisionViewFor(a.id).iFoundUnshared; trip++) {
    p.applyDecision(a.id, { action: "scout", reason: "looking" });
    let t = 0;
    while (t < 60 && a.state === "scouting") { p.tick(0.05); t += 0.05; }
  }
  assert.ok(p.decisionViewFor(a.id).iFoundUnshared, "Pip found the pass");
  p.applyDecision(a.id, { action: "share", reason: "sharing" });
  assert.equal(b.state, "fetching", "Marlo still en route");
  const newPathUsesPass = b.path.some((pt) => Math.floor(pt.y) === l.passY && Math.floor(pt.x) >= l.rx0 && Math.floor(pt.x) <= l.rx1);
  assert.ok(newPathUsesPass, "Marlo's route now goes through the pass");
  const s = p.snapshot();
  const marlo = s.stats.routeUpdates.find((u) => u.name === "Marlo");
  assert.ok(marlo, "Marlo got a route update");
  assert.equal(marlo.via, "Pip");
  assert.ok(s.stats.routeUpdates.every((u) => u.via === "Pip"), "every route update credits the sharer");
  assert.ok(s.log.some((line) => line.text.includes("automatically updated") && line.text.includes("Pip shared")),
    "feed credits the share as an automatic route update, not Marlo's own reasoning");
});

test("sharing off: a share is rejected and nobody else learns", () => {
  const p = new Expedition(CREW, 7);
  p.setSharing(false);
  const a = p.members[0];
  for (let trip = 0; trip < 6 && !p.decisionViewFor(a.id).iFoundUnshared; trip++) {
    p.applyDecision(a.id, { action: "scout", reason: "looking" });
    let t = 0;
    while (t < 60 && a.state === "scouting") { p.tick(0.05); t += 0.05; }
  }
  assert.ok(p.decisionViewFor(a.id).iFoundUnshared, "Pip found the pass");
  const res = p.applyDecision(a.id, { action: "share", reason: "telling" });
  assert.equal(res.ok, false);
  assert.match(res.why ?? "", /sharing is off/);
  assert.equal(p.snapshot().pass.knownBy.length, 1, "only the discoverer knows");
  assert.equal(p.decisionViewFor(p.members[1].id).passIKnow, null);
  // the discoverer CAN use its own private knowledge
  assert.equal(p.walkableFor(a.id, p.layout.rx0 + 0.5, p.layout.passY + 0.5), true);
  assert.equal(p.walkableFor(p.members[1].id, p.layout.rx0 + 0.5, p.layout.passY + 0.5), false);
});

test("decision validation: no fetching claimed crates, no sharing others' discoveries", () => {
  const p = new Expedition(CREW, 7);
  const [a, b] = p.members;
  assert.equal(p.applyDecision(a.id, { action: "fetch", crate: "crate-9", reason: "" }).ok, false);
  assert.ok(p.applyDecision(a.id, { action: "fetch", crate: "crate-0", reason: "" }).ok);
  assert.equal(p.applyDecision(b.id, { action: "fetch", crate: "crate-0", reason: "" }).ok, false, "already claimed");
  assert.equal(p.applyDecision(b.id, { action: "share", reason: "" }).ok, false, "nothing to share");
  assert.equal(p.applyDecision(a.id, { action: "scout", reason: "" }).ok, false, "busy members cannot scout");
  assert.equal(p.applyDecision(b.id, { action: "wait", reason: "" }).ok, true);
});

test("private knowledge shortens only the knower's own view of routes", () => {
  const p = new Expedition(CREW, 7);
  const [a, b] = p.members;
  (p as unknown as { discovered: Set<string> }).discovered.add(a.id);
  const va = p.decisionViewFor(a.id);
  const vb = p.decisionViewFor(b.id);
  assert.ok(va.passIKnow && va.passIKnow.foundBy === "me");
  assert.equal(vb.passIKnow, null);
  for (const cid of ["crate-0", "crate-1"]) {
    const ra = va.crates.find((c) => c.id === cid)!.routeTiles!;
    const rb = vb.crates.find((c) => c.id === cid)!.routeTiles!;
    assert.ok(ra < rb, `${cid}: knower sees ${ra} tiles, other sees ${rb}`);
  }
});
