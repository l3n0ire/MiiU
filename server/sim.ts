import {
  asUser, USER_ID,
  type Line, type LLM, type Outcome, type PairInfo,
} from "./llm.ts";
import {
  LANDMARKS, getRel, newCharacter, placeName, randomWalkable, recordRelChange, relKey, workplaceFor,
  type Character, type Relationship, type Vec, type World, type WorldEvent, type WorldStore,
} from "./world.ts";

const TICK_MS = 200;
const WALK_SPEED = 1.5; // tiles per sim-second
const MEET_DIST = 1.4;
const PAIR_COOLDOWN = 60_000; // sim-ms before the same pair chats again
const LINE_MS = 3_500; // sim-ms each speech bubble stays up
const GROUP_DIST = 2.2; // bystanders this close to a meeting join in
const MAX_GROUP = 4;
const MAX_TURNS = 8; // hard cap on lines per conversation
// User chats have no line cap; this sentinel keeps the "winding down" prompt pressure off.
const USER_CHAT_ONGOING = 99;
const SPAWN_LABELS = ["friend", "best friend", "crush", "family"]; // qualifying bond stages
const MIN_LINES_BEFORE_LEAVING = 2; // nobody walks off before this many lines have been said

// Tunables the host can adjust (Node server: from MIIU_* env vars; browser app: defaults).
export interface SimConfig {
  maxChats?: number; // concurrent resident conversations, default 3
  autoEvents?: boolean; // spontaneous world events (issue #2), default on
  autoEventMin?: number; // chats between events, lower bound, default 2
  autoEventMax?: number; // upper bound, default 5
  autoEventCooldown?: number; // sim-ms between auto events, default 120_000
  maxPopulation?: number; // hard cap incl. manual additions (issue #4), default 15
  spawning?: boolean; // residents bringing in newcomers, default on
  spawnAffinity?: number; // bond strength that qualifies, default 50
  spawnChance?: number; // default 0.35
  playerSpawning?: boolean; // player-bond spawning (issue #13), default on
  socialWander?: boolean; // memories/relationships bias wandering (issue #11), default on
}
type ResolvedSimConfig = Required<SimConfig>;

function resolveConfig(c: SimConfig = {}): ResolvedSimConfig {
  const autoEventMin = Math.max(1, c.autoEventMin ?? 2);
  return {
    maxChats: c.maxChats ?? 3,
    autoEvents: c.autoEvents ?? true,
    autoEventMin,
    autoEventMax: Math.max(autoEventMin, c.autoEventMax ?? 5),
    autoEventCooldown: c.autoEventCooldown ?? 120_000,
    maxPopulation: Math.max(1, c.maxPopulation ?? 15),
    spawning: c.spawning ?? true,
    spawnAffinity: c.spawnAffinity ?? 50,
    spawnChance: Math.min(1, Math.max(0, c.spawnChance ?? 0.35)),
    playerSpawning: c.playerSpawning ?? true,
    socialWander: c.socialWander ?? true,
  };
}
const WANDER_CANDIDATES = 5; // candidate targets scored per pick
// Strong labels pull toward, mild labels pull gently, hostile labels push away.
const PULL: Record<string, number> = {
  crush: 1, "best friend": 1, friend: 0.8, family: 0.9, mentor: 0.6,
  acquaintance: 0.3, neighbor: 0.3, coworker: 0.3, frenemy: 0.2,
  rival: -0.8, enemy: -1, ex: -0.7,
};
// Good moods seek company; bad moods want space.
const SOCIAL_MOOD = new Set(["happy", "excited", "love"]);
const PRIVATE_MOOD = new Set(["sad", "angry"]);

interface UserChat {
  userName: string;
  members: Character[]; // miis still in the chat
  allMembers: Character[]; // every mii who joined (for the summary)
  pairs: PairInfo[]; // mii-mii pairs only
  place: string;
  lines: Line[]; // user lines have speaker = userName; speaker "" = system note
  replyQueue: Character[]; // miis who owe a reply
  generating: boolean;
  ended: boolean;
  summarizing: boolean;
}

interface ActiveChat {
  members: Character[];
  present: Character[]; // still in the conversation (speakers can walk away)
  pairs: PairInfo[];
  place: string;
  lines: Line[]; // generated so far
  idx: number; // lines shown so far
  nextAt: number;
  lastSpeaker: Character | null;
  generating: boolean;
  finished: boolean; // no more lines will be generated
  outcome: Outcome | null;
}

// Never persist or print provider error bodies verbatim: they can echo a rejected
// credential fragment (OpenAI 401s include a truncated key). Generic text in the island
// record; scrubbed + bounded text in console output.
const scrubErr = (err: unknown): string =>
  String((err as Error)?.message ?? err).replace(/sk-[A-Za-z0-9_-]{2,}/g, "sk-...").slice(0, 200);

export class Sim {
  now = 0;
  paused = false;
  speed = 1;
  private chats: ActiveChat[] = [];
  private userChat: UserChat | null = null;
  private forced = new Set<string>();
  private eventBusy = false;
  private chatsSinceEvent = 0;
  private nextAutoEvent = 0;
  private lastAutoEvent: number;
  private recentChats: { place: string; lines: Line[] }[] = [];
  private cfg: ResolvedSimConfig;
  private llm: LLM;
  private store?: WorldStore;

  constructor(
    public world: World,
    private onEvent: (e: WorldEvent) => void,
    opts: { llm: LLM; store?: WorldStore; config?: SimConfig },
  ) {
    this.llm = opts.llm;
    this.store = opts.store;
    this.cfg = resolveConfig(opts.config);
    this.lastAutoEvent = -this.cfg.autoEventCooldown;
    this.nextAutoEvent = this.rollNextAuto();
    setInterval(() => this.tick(), TICK_MS);
  }

  private persist() {
    this.store?.save(this.world);
  }

  private rollNextAuto() {
    return this.cfg.autoEventMin + Math.floor(Math.random() * (this.cfg.autoEventMax - this.cfg.autoEventMin + 1));
  }

  private log(e: Omit<WorldEvent, "t">) {
    const ev = { t: Date.now(), ...e };
    this.world.events.push(ev);
    if (this.world.events.length > 200) this.world.events.shift();
    this.onEvent(ev);
  }

  addCharacter(c: Character) {
    if (this.world.characters.length >= this.cfg.maxPopulation) {
      this.log({ kind: "system", participants: [], text: `${c.name} wanted to move in, but the island is full (max ${this.cfg.maxPopulation}).` });
      return;
    }
    this.world.characters.push(c);
    this.log({ kind: "join", participants: [c.id], text: `${c.name} moved to the island!` });
    this.persist();
  }

  removeCharacter(id: string) {
    if (this.chats.some((ch) => ch.members.some((m) => m.id === id))) return;
    if (this.userChat?.allMembers.some((m) => m.id === id)) return;
    this.world.characters = this.world.characters.filter((c) => c.id !== id);
    for (const k of Object.keys(this.world.relationships)) if (k.split("|").includes(id)) delete this.world.relationships[k];
    this.persist();
  }

  forceTalk(aId: string, bId: string) {
    const a = this.byId(aId), b = this.byId(bId);
    if (!a || !b || a === b) return;
    const mid = { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 };
    for (const c of [a, b]) if (c.state !== "talking") { c.state = "wandering"; c.target = { ...mid }; }
    this.forced.add(relKey(a.id, b.id));
  }

  async triggerEvent(text: string, targetId: string | null, gatherAt: string | null) {
    if (this.eventBusy) return;
    const targets = targetId ? this.world.characters.filter((c) => c.id === targetId) : this.world.characters;
    if (!targets.length) return;
    const landmark = LANDMARKS.find((l) => l.name === gatherAt);
    const headline = landmark ? `${text} (at the ${landmark.name})` : text;

    this.eventBusy = true;
    if (landmark) {
      for (const c of targets) {
        if (c.state === "talking") continue;
        c.state = "wandering";
        c.target = { x: landmark.x + Math.random() * landmark.w, y: landmark.y + Math.random() * landmark.h };
        c.idleUntil = this.now + 45_000; // linger at the gathering once they arrive
      }
    }
    try {
      const reactions = await this.llm.generateReactions(headline, targets);
      const lines = [];
      for (const r of reactions) {
        const c = targets.find((t) => t.name === r.name);
        if (!c) continue;
        c.mood = r.mood;
        c.memories.push(`(island news) ${r.memory}`);
        if (c.memories.length > 10) c.memories.shift();
        if (c.state !== "talking") { c.bubble = r.says; c.bubbleUntil = this.now + 5000; }
        lines.push({ speaker: c.name, text: r.says });
      }
      this.log({ kind: "world", participants: targets.map((c) => c.id), place: landmark?.name, text: `📣 ${headline}`, lines });
      this.persist();
    } catch (err) {
      console.error("LLM error:", scrubErr(err));
      this.log({ kind: "system", participants: [], text: `📣 ${headline} (nobody reacted: the island's model had a problem)` });
    } finally {
      this.eventBusy = false;
    }
  }

  // ---------- user chat (issue #1: chat directly with one or more miis) ----------

  startUserChat(ids: string[], userName = "You") {
    if (this.userChat && !this.userChat.ended) return;
    const seen = new Set<string>();
    const members = ids
      .map((id) => this.byId(id))
      .filter((c): c is Character => !!c && c.state !== "talking" && !seen.has(c.id) && !!seen.add(c.id))
      .slice(0, 4);
    if (!members.length) {
      this.log({ kind: "system", participants: [], text: `${userName} tried to start a chat, but nobody was free.` });
      return;
    }
    const chat: UserChat = {
      userName,
      members: [...members],
      allMembers: [...members],
      pairs: this.pairsOf(members),
      place: placeName(members[0].pos),
      lines: [{ speaker: "", text: `${userName} started a chat with ${listNames(members)}.` }],
      replyQueue: [],
      generating: false,
      ended: false,
      summarizing: false,
    };
    for (const c of members) { c.state = "talking"; c.bubble = null; }
    this.userChat = chat;
  }

  userChatMessage(text: string) {
    const chat = this.userChat;
    if (!chat || chat.ended || chat.summarizing) return;
    text = text.trim().slice(0, 500);
    if (!text) return;
    chat.lines.push({ speaker: chat.userName, text });
    if (chat.lines.length > 200) chat.lines.splice(0, chat.lines.length - 200);

    // Who answers: anyone named in the message, otherwise the mii silent longest; a second may chime in.
    const lower = text.toLowerCase();
    const mentioned = chat.members.filter((m) => lower.includes(m.name.toLowerCase())).slice(0, 2);
    let responders = mentioned;
    if (!responders.length) {
      const lastLine = new Map<string, number>();
      chat.lines.forEach((l, i) => {
        const c = chat.members.find((m) => m.name === l.speaker);
        if (c) lastLine.set(c.id, i);
      });
      const sorted = [...chat.members].sort((a, b) => (lastLine.get(a.id) ?? -1) - (lastLine.get(b.id) ?? -1));
      responders = sorted.slice(0, 1);
      if (chat.members.length > 1 && Math.random() < 0.4 && sorted[1]) responders.push(sorted[1]);
    }
    for (const r of responders) if (!chat.replyQueue.includes(r)) chat.replyQueue.push(r);
    this.pumpUserChat();
  }

  private pumpUserChat(): void {
    const chat = this.userChat;
    if (!chat || chat.ended || chat.generating || chat.summarizing || !chat.replyQueue.length) return;
    const speaker = chat.replyQueue.shift()!;
    if (!chat.members.includes(speaker)) return this.pumpUserChat();
    chat.generating = true;
    const others = [...chat.members.filter((c) => c !== speaker), asUser(chat.userName)];
    const canLeave = chat.lines.some((l) => l.speaker === speaker.name);
    const activity = this.recentActivityFor(speaker);
    const lastBond = getRel(this.world, speaker.id, USER_ID).history.at(-1);
    if (lastBond) activity.unshift(`You last talked with ${chat.userName}: "${lastBond.slice(0, 120)}"`);
    this.llm.generateLine(speaker, others, chat.pairs, chat.lines.filter((l) => l.speaker), chat.place, USER_CHAT_ONGOING, canLeave, activity)
      .then(({ says, wants_to_leave }) => {
        if (chat.ended) return; // chat closed while this reply was generating
        chat.lines.push({ speaker: speaker.name, text: says });
        speaker.bubble = says;
        speaker.bubbleUntil = this.now + 5000;
        if (wants_to_leave && canLeave) {
          chat.members = chat.members.filter((c) => c !== speaker);
          chat.lines.push({ speaker: "", text: `${speaker.name} headed off.` });
          speaker.state = "idle";
          speaker.idleUntil = Math.max(speaker.idleUntil, this.now + 1500);
          if (!chat.members.length) return this.endUserChat();
        }
      })
      .catch((err) => {
        console.error("LLM error (user chat):", scrubErr(err));
        chat.lines.push({ speaker: "", text: `${speaker.name} couldn't think of anything to say (LLM error).` });
      })
      .finally(() => {
        chat.generating = false;
        this.pumpUserChat();
      });
  }

  endUserChat() {
    const chat = this.userChat;
    if (!chat || chat.ended || chat.summarizing) return;
    chat.ended = true;
    chat.replyQueue = [];
    const finish = () => {
      const active = this.userChat && !this.userChat.ended && this.userChat !== chat ? this.userChat : null;
      for (const c of chat.allMembers) {
        if (c.state !== "talking") continue;
        if (active?.allMembers.includes(c)) continue; // already chatting in a newer chat
        c.state = "idle";
        c.idleUntil = Math.max(c.idleUntil, this.now + 1500);
      }
    };
    const spoken = chat.lines.filter((l) => l.speaker);
    if (spoken.length < 2 || !chat.allMembers.length) { finish(); return; }
    chat.summarizing = true;
    this.llm.summarizeConversation(chat.allMembers, chat.pairs, spoken, chat.place, chat.userName)
      .then((outcome) => {
        applyChatOutcome(this.world, chat.allMembers, outcome, { place: chat.place, userName: chat.userName });
        this.recentChats.push({ place: chat.place, lines: spoken.slice(-8) });
        if (this.recentChats.length > 3) this.recentChats.shift();
        this.persist();
        this.maybeAutoEvent(); // user chats are completed conversations too (issue #2)
        this.maybePlayerSpawn(chat);
      })
      .catch((err) => console.error("LLM error (user chat summary):", scrubErr(err)))
      .finally(() => { chat.summarizing = false; finish(); });
  }

  private byId(id: string) {
    return this.world.characters.find((c) => c.id === id);
  }

  private tick() {
    if (this.paused) return;
    const dt = TICK_MS * this.speed;
    this.now += dt;

    for (const c of this.world.characters) {
      if (c.state === "talking") continue;
      if (c.bubble && c.bubbleUntil && this.now >= c.bubbleUntil) c.bubble = null;
      if (c.state === "idle") {
        if (this.now >= c.idleUntil) {
          c.state = "wandering";
          const wp = workplaceFor(c.occupation);
          c.target = wp && Math.random() < 0.5 // residents drift toward work half the time (issue #6)
            ? { x: wp.x + Math.random() * wp.w, y: wp.y + Math.random() * wp.h }
            : this.pickWanderTarget(c); // otherwise relationships and mood steer the drift (issue #11)
        }
        continue;
      }
      const dx = c.target.x - c.pos.x, dy = c.target.y - c.pos.y;
      const dist = Math.hypot(dx, dy);
      const step = (WALK_SPEED * dt) / 1000;
      if (dist <= step) {
        c.pos = { ...c.target };
        c.state = "idle";
        c.idleUntil = Math.max(c.idleUntil, this.now + 2000 + Math.random() * 4000);
      } else {
        c.pos.x += (dx / dist) * step;
        c.pos.y += (dy / dist) * step;
      }
    }

    for (const chat of [...this.chats]) this.advanceChat(chat);
    if (this.chats.length < this.cfg.maxChats) this.findMeeting();
  }

  // Pick the next wander target: a few random candidates, scored by who would be nearby.
  // Liked miis pull their favorites closer, rivals and exes get space, and mood tilts the
  // balance between seeking company and wanting solitude.
  private pickWanderTarget(c: Character): Vec {
    if (!this.cfg.socialWander) return randomWalkable();
    const others = this.world.characters.filter((o) => o !== c && o.state !== "talking");
    if (!others.length) return randomWalkable();
    const pulls = others.map((o) => {
      const rel = this.world.relationships[relKey(c.id, o.id)];
      let w = rel ? (PULL[rel.label] ?? 0) * (rel.affinity / 100) : 0;
      if (SOCIAL_MOOD.has(c.mood) && w > 0) w *= 1.5; // fresh from a good chat: seek company
      if (PRIVATE_MOOD.has(c.mood)) w *= w > 0 ? 0.3 : 1.5; // snubbed: solitude, and extra distance from disliked miis
      return { o, w };
    });
    let best = randomWalkable(), bestScore = -Infinity;
    for (let i = 0; i < WANDER_CANDIDATES; i++) {
      const cand = i === 0 ? best : randomWalkable();
      let score = 0;
      for (const { o, w } of pulls) {
        if (!w) continue;
        const d = Math.hypot(cand.x - o.pos.x, cand.y - o.pos.y);
        score += (w * 8) / (1 + d / 3); // stronger bonds and closer candidates weigh more
      }
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    return best;
  }

  private findMeeting() {
    const free = this.world.characters.filter((c) => c.state !== "talking");
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        const a = free[i], b = free[j];
        if (Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) > MEET_DIST) continue;
        const key = relKey(a.id, b.id);
        const rel = getRel(this.world, a.id, b.id);
        if (!this.forced.has(key) && rel.lastTalk && this.now - rel.lastTalk < pairCooldown(rel)) continue;
        this.forced.delete(key);
        const center = { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 };
        const dist = (c: Character) => Math.hypot(c.pos.x - center.x, c.pos.y - center.y);
        const bystanders = free
          .filter((c) => c !== a && c !== b && dist(c) <= GROUP_DIST)
          .sort((x, y) => dist(x) - dist(y))
          .slice(0, MAX_GROUP - 2);
        this.startChat([a, b, ...bystanders]);
        return;
      }
    }
  }

  private pairsOf(members: Character[]): PairInfo[] {
    const pairs = [];
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++)
        pairs.push({ a: members[i], b: members[j], rel: getRel(this.world, members[i].id, members[j].id) });
    return pairs;
  }

  // Recent chats involving this resident plus the latest island headline, so new
  // conversations build on what already happened instead of restarting the same
  // small talk every time (issue #31).
  private recentActivityFor(speaker: Character): string[] {
    const out: string[] = [];
    const events = this.world.events;
    // Priority order: island news, then this resident's most recent chats. generateLine
    // keeps the first 4 entries, and pumpUserChat prepends the player-bond line, so the
    // highest-priority context always survives the cap.
    const news = [...events].reverse().find((ev) => ev.kind === "world");
    if (news) out.push(`Island news: ${news.text.slice(0, 120)}`);
    for (let i = events.length - 1; i >= 0 && out.length < 4; i--) {
      const ev = events[i];
      if (ev.kind !== "chat" || !ev.participants.includes(speaker.id)) continue;
      const others = ev.participants
        .filter((id) => id !== speaker.id)
        .map((id) => this.byId(id)?.name)
        .filter((n): n is string => Boolean(n))
        .join(" & ");
      const first = ev.lines?.find((l) => l.speaker)?.text.slice(0, 100);
      out.push(`You chatted with ${others || "someone"}${ev.place ? ` at ${ev.place}` : ""}${first ? `: "${first}"` : ""}`);
    }
    return out;
  }

  private startChat(members: Character[]) {
    const chat: ActiveChat = {
      members,
      present: [...members],
      pairs: this.pairsOf(members),
      place: placeName(members[0].pos),
      lines: [],
      idx: 0,
      nextAt: 0,
      lastSpeaker: null,
      generating: false,
      finished: false,
      outcome: null,
    };
    this.chats.push(chat);
    for (const c of members) { c.state = "talking"; c.bubble = "…"; }
  }

  // Kick off whichever LLM call this chat needs next: the next line, or the summary once it's over.
  private pump(chat: ActiveChat) {
    if (chat.generating || chat.outcome) return;
    if (chat.finished) {
      chat.generating = true;
      this.llm.summarizeConversation(chat.members, chat.pairs, chat.lines, chat.place)
        .then((o) => { chat.outcome = o; })
        .catch((err) => {
          console.error("LLM error (summary):", scrubErr(err));
          chat.outcome = { outcomes: [], pairs: [] };
        })
        .finally(() => { chat.generating = false; });
      return;
    }
    // Write at most one line ahead of what's on screen, so the next line is ready when the bubble changes.
    if (chat.lines.length > chat.idx) return;

    const speaker = this.pickSpeaker(chat);
    chat.generating = true;
    this.llm.generateLine(speaker, chat.present.filter((c) => c !== speaker), chat.pairs, chat.lines, chat.place, MAX_TURNS - chat.lines.length, chat.lines.length >= MIN_LINES_BEFORE_LEAVING, this.recentActivityFor(speaker))
      .then(({ says, wants_to_leave }) => {
        chat.lines.push({ speaker: speaker.name, text: says });
        chat.lastSpeaker = speaker;
        if (wants_to_leave && chat.lines.length > MIN_LINES_BEFORE_LEAVING) chat.present = chat.present.filter((c) => c !== speaker);
        if (chat.lines.length >= MAX_TURNS || chat.present.length < 2) chat.finished = true;
      })
      .catch((err) => {
        if (chat.lines.length >= 2) { console.error("LLM error (line):", scrubErr(err)); chat.finished = true; }
        else this.failChat(chat, err);
      })
      .finally(() => { chat.generating = false; });
  }

  private pickSpeaker(chat: ActiveChat): Character {
    const candidates = chat.present.filter((c) => c !== chat.lastSpeaker);
    const last = chat.lines.at(-1)?.text.toLowerCase() ?? "";
    const addressed = candidates.find((c) => last.includes(c.name.toLowerCase()));
    if (addressed) return addressed;
    const silent = candidates.filter((c) => !chat.lines.some((l) => l.speaker === c.name));
    const pool = silent.length ? silent : candidates;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private advanceChat(chat: ActiveChat) {
    this.pump(chat);
    if (this.now < chat.nextAt) return;
    if (chat.idx < chat.lines.length) {
      const line = chat.lines[chat.idx];
      for (const c of chat.members) c.bubble = c.name === line.speaker ? line.text : null;
      chat.idx++;
      chat.nextAt = this.now + LINE_MS;
      return;
    }
    if (chat.finished && chat.outcome) this.finishChat(chat, chat.outcome);
  }

  private finishChat(chat: ActiveChat, outcome: Outcome) {
    const { members } = chat;
    const changes = applyChatOutcome(this.world, members, outcome, { place: chat.place });
    for (const p of chat.pairs) p.rel.lastTalk = this.now;

    this.log({
      kind: "chat",
      participants: members.map((c) => c.id),
      place: chat.place,
      lines: chat.lines,
      text: `${listNames(members)} → ${changes.join(", ") || "no change"}`,
    });
    this.recentChats.push({ place: chat.place, lines: chat.lines.slice(-8) });
    if (this.recentChats.length > 3) this.recentChats.shift();
    this.endChat(chat);
    this.persist();
    this.maybeAutoEvent();
    this.maybeSpawn(chat.pairs);
  }

  // Roll for a spontaneous event after a random number of completed chats (issue #2).
  private maybeAutoEvent() {
    if (!this.cfg.autoEvents) return;
    this.chatsSinceEvent += 1;
    if (this.chatsSinceEvent < this.nextAutoEvent) return;
    if (this.eventBusy || this.now - this.lastAutoEvent < this.cfg.autoEventCooldown) return;
    this.chatsSinceEvent = 0;
    this.nextAutoEvent = this.rollNextAuto();
    this.lastAutoEvent = this.now;
    this.llm.generateEvent(this.recentChats, this.world.characters, LANDMARKS.map((l) => l.name))
      .then((ev) => {
        const target = this.world.characters.find((c) => c.name === ev.target);
        this.log({ kind: "system", participants: [], text: `🎲 The island stirs...` });
        void this.triggerEvent(ev.headline, target?.id ?? null, ev.gather === "nowhere" ? null : ev.gather);
      })
      .catch((err) => console.error("LLM error (auto event):", scrubErr(err)));
  }

  // A mii whose bond with the player is strong enough can invite someone from off-island (issue #13).
  // Same population cap and arrival flow as resident-pair spawns; only the trigger differs.
  private maybePlayerSpawn(chat: UserChat) {
    if (!this.cfg.playerSpawning || this.world.characters.length >= this.cfg.maxPopulation) return;
    const strong = chat.allMembers.filter((c) => {
      const rel = this.world.relationships[relKey(c.id, USER_ID)];
      return rel && rel.affinity >= this.cfg.spawnAffinity && SPAWN_LABELS.includes(rel.label);
    });
    if (!strong.length || Math.random() >= this.cfg.spawnChance) return;
    const inviter = strong[Math.floor(Math.random() * strong.length)];
    this.llm.generateResident(inviter, this.world.characters)
      .then((r) => {
        if (this.world.characters.length >= this.cfg.maxPopulation) return; // re-check: cap still binding after async gap
        const c = newCharacter({ name: r.name, personality: r.personality, likes: r.likes, dislikes: r.dislikes, color: r.color });
        this.addCharacter(c);
        if (!this.world.characters.includes(c)) return; // addCharacter refused (cap)
        const rel = getRel(this.world, inviter.id, c.id);
        rel.affinity = 30;
        rel.label = r.relationship;
        recordRelChange(rel, 30, `${c.name} arrived because of ${chat.userName}.`, null);
        rel.history.push(`${c.name} arrived because of ${chat.userName}.`);
        this.persist();
        void this.triggerEvent(`${c.name} arrived on the island, invited by ${inviter.name} because of you!`, null, null);
      })
      .catch((err) => console.error("LLM error (player spawn):", scrubErr(err)));
  }

  private maybeSpawn(pairs: PairInfo[]) {
    if (!this.cfg.spawning || this.world.characters.length >= this.cfg.maxPopulation) return;
    const strong = pairs.filter((p) => p.rel.affinity >= this.cfg.spawnAffinity && SPAWN_LABELS.includes(p.rel.label));
    if (!strong.length || Math.random() >= this.cfg.spawnChance) return;
    const bond = strong[Math.floor(Math.random() * strong.length)];
    this.llm.generateResident(bond.a, this.world.characters)
      .then((r) => {
        if (this.world.characters.length >= this.cfg.maxPopulation) return; // re-check: cap still binding after async gap
        const c = newCharacter({ name: r.name, personality: r.personality, likes: r.likes, dislikes: r.dislikes, color: r.color });
        this.addCharacter(c);
        if (!this.world.characters.includes(c)) return; // addCharacter refused (cap)
        const rel = getRel(this.world, bond.a.id, c.id);
        rel.affinity = 30;
        rel.label = r.relationship;
        recordRelChange(rel, 30, `${c.name} arrived because of ${bond.a.name}.`, null);
        rel.history.push(`${c.name} arrived because of ${bond.a.name}.`);
        this.persist();
        void this.triggerEvent(`${c.name} arrived on the island, brought by ${bond.a.name}!`, null, null);
      })
      .catch((err) => console.error("LLM error (spawn):", scrubErr(err)));
  }

  private failChat(chat: ActiveChat, err: Error) {
    console.error("LLM error:", scrubErr(err));
    this.log({ kind: "system", participants: chat.members.map((c) => c.id), text: `${listNames(chat.members)} stared at each other awkwardly (the island's model had a problem)` });
    for (const p of chat.pairs) p.rel.lastTalk = this.now;
    this.endChat(chat);
  }

  private endChat(chat: ActiveChat) {
    for (const c of chat.members) {
      c.bubble = null;
      c.state = "idle";
      c.idleUntil = Math.max(c.idleUntil, this.now + 1500);
    }
    this.chats = this.chats.filter((ch) => ch !== chat);
  }

  private status() {
    if (this.userChat && !this.userChat.ended)
      return `${this.userChat.userName} is chatting with ${listNames(this.userChat.members) || "everyone"}${this.userChat.generating ? " (typing…)" : ""}`;
    if (this.eventBusy) return "📣 The island is reacting…";
    if (!this.chats.length) return "idle";
    return this.chats
      .map((ch) => `${listNames(ch.members)} ${ch.idx ? "chatting" : "thinking…"} at ${ch.place}`)
      .join(" · ");
  }

  snapshot() {
    return {
      characters: this.world.characters,
      relationships: Object.values(this.world.relationships),
      paused: this.paused,
      speed: this.speed,
      status: this.status(),
      chats: this.chats.map((ch) => ch.members.map((c) => c.id)),
      userChat: this.userChat && !this.userChat.ended
        ? {
            active: true,
            userName: this.userChat.userName,
            members: this.userChat.members.map((c) => ({ id: c.id, name: c.name, color: c.color })),
            lines: this.userChat.lines,
            thinking: this.userChat.generating,
            place: this.userChat.place,
          }
        : null,
    };
  }
}

const FACTS_CAP = 50; // durable per-resident facts (issue #23); FIFO beyond the cap

// Apply a conversation summary to the world: relationship changes, episodic memories
// (skipped when the summarizer judged the chat routine), and durable facts. Exported so
// external eval drivers persist outcomes exactly like the live Sim (issue #23).
export function applyChatOutcome(
  world: World,
  members: Character[],
  outcome: Outcome,
  opts: { place: string; userName?: string },
): string[] {
  const { place, userName } = opts;
  const groupNote = members.length > 2 ? " (group chat)" : "";
  const byName = (n: string) => members.find((c) => c.name === n);
  const changes: string[] = [];

  // Bonds with the player live in ordinary Relationship records keyed by USER_ID.
  for (const b of outcome.player_bonds ?? []) {
    const c = byName(b.name);
    if (!c) continue;
    const rel = getRel(world, c.id, USER_ID);
    const before = rel.timeline.length ? rel.label : null;
    rel.affinity = Math.max(-100, Math.min(100, rel.affinity + b.affinity_delta));
    rel.label = b.relationship;
    recordRelChange(rel, b.affinity_delta, `Bond with ${userName} at ${place}`, before);
    rel.history.push(`Bond with ${userName} at ${place}: ${outcome.outcomes.find((o) => o.name === c.name)?.memory || "a chat"}`);
    if (rel.history.length > 10) rel.history.shift();
  }

  for (const p of outcome.pairs) {
    const a = byName(p.a), b = byName(p.b);
    if (!a || !b) continue;
    const rel = getRel(world, a.id, b.id);
    const before = rel.timeline.length ? rel.label : null;
    rel.affinity = Math.max(-100, Math.min(100, rel.affinity + p.affinity_delta));
    rel.label = p.relationship;
    const cause = userName ? `Chatting with ${userName} at ${place}` : `Chat at ${place}${groupNote}`;
    recordRelChange(rel, p.affinity_delta, cause, before);
    const memory = outcome.outcomes.find((o) => o.name === a.name)?.memory;
    if (userName) {
      rel.history.push(`${cause}: ${memory || "a chat"}`);
      if (rel.history.length > 10) rel.history.shift();
    } else if (memory) {
      rel.history.push(`At ${place}${groupNote}: ${memory}`);
      if (rel.history.length > 10) rel.history.shift();
    }
    changes.push(`${a.name}–${b.name}: ${rel.label} (${p.affinity_delta >= 0 ? "+" : ""}${p.affinity_delta})`);
  }

  for (const o of outcome.outcomes) {
    const c = byName(o.name);
    if (!c) continue;
    c.mood = o.mood;
    const text = (o.memory ?? "").trim();
    if (text) {
      c.memories.push(userName ? `(chatting with ${userName}) ${text}` : `(with ${listNames(members.filter((m) => m !== c))}) ${text}`);
      if (c.memories.length > 10) c.memories.shift();
    }
    for (const f of o.facts ?? []) {
      const fact = String(f).trim();
      if (!fact || c.facts.includes(fact)) continue;
      c.facts.push(fact);
      if (c.facts.length > FACTS_CAP) c.facts.shift();
    }
  }
  return changes;
}

// Close bonds reunite sooner; hostile pairs get a longer cooldown (issue #11).
function pairCooldown(rel: Relationship): number {
  const pull = PULL[rel.label] ?? 0;
  if (pull >= 0.8 && rel.affinity >= 50) return PAIR_COOLDOWN * 0.25;
  if (pull <= -0.7) return PAIR_COOLDOWN * 2.5;
  return PAIR_COOLDOWN;
}

function listNames(cs: Character[]) {
  const n = cs.map((c) => c.name);
  return n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} & ${n[n.length - 1]}`;
}
