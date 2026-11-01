import {
  asUser, generateEvent, generateLine, generateReactions, summarizeConversation,
  type Line, type Outcome, type PairInfo,
} from "./llm.ts";
import {
  LANDMARKS, getRel, placeName, randomWalkable, relKey, saveWorld,
  type Character, type World, type WorldEvent,
} from "./world.ts";

const TICK_MS = 200;
const WALK_SPEED = 1.5; // tiles per sim-second
const MEET_DIST = 1.4;
const PAIR_COOLDOWN = 60_000; // sim-ms before the same pair chats again
const LINE_MS = 3_500; // sim-ms each speech bubble stays up
const GROUP_DIST = 2.2; // bystanders this close to a meeting join in
const MAX_GROUP = 4;
const MAX_CHATS = Number(process.env.MIIU_MAX_CHATS ?? 3);
const MAX_TURNS = 8; // hard cap on lines per conversation
// User chats have no line cap; this sentinel keeps the "winding down" prompt pressure off.
const USER_CHAT_ONGOING = 99;

// Spontaneous world events generated from recent conversation history (issue #2).
const AUTO_EVENTS = process.env.MIIU_AUTO_EVENTS !== "off";
const AUTO_MIN = Math.max(1, Number(process.env.MIIU_AUTO_EVENT_MIN ?? 2)); // chats between events, lower bound
const AUTO_MAX = Math.max(AUTO_MIN, Number(process.env.MIIU_AUTO_EVENT_MAX ?? 5)); // upper bound
const AUTO_COOLDOWN = Number(process.env.MIIU_AUTO_EVENT_COOLDOWN ?? 120_000); // sim-ms between auto events
const rollNextAuto = () => AUTO_MIN + Math.floor(Math.random() * (AUTO_MAX - AUTO_MIN + 1));
const MIN_LINES_BEFORE_LEAVING = 2; // nobody walks off before this many lines have been said

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

export class Sim {
  now = 0;
  paused = false;
  speed = 1;
  private chats: ActiveChat[] = [];
  private userChat: UserChat | null = null;
  private forced = new Set<string>();
  private eventBusy = false;
  private chatsSinceEvent = 0;
  private nextAutoEvent = rollNextAuto();
  private lastAutoEvent = -AUTO_COOLDOWN;
  private recentChats: { place: string; lines: Line[] }[] = [];

  constructor(
    public world: World,
    private onEvent: (e: WorldEvent) => void,
  ) {
    setInterval(() => this.tick(), TICK_MS);
  }

  private log(e: Omit<WorldEvent, "t">) {
    const ev = { t: Date.now(), ...e };
    this.world.events.push(ev);
    if (this.world.events.length > 200) this.world.events.shift();
    this.onEvent(ev);
  }

  addCharacter(c: Character) {
    this.world.characters.push(c);
    this.log({ kind: "join", participants: [c.id], text: `${c.name} moved to the island!` });
    saveWorld(this.world);
  }

  removeCharacter(id: string) {
    if (this.chats.some((ch) => ch.members.some((m) => m.id === id))) return;
    if (this.userChat?.allMembers.some((m) => m.id === id)) return;
    this.world.characters = this.world.characters.filter((c) => c.id !== id);
    for (const k of Object.keys(this.world.relationships)) if (k.split("|").includes(id)) delete this.world.relationships[k];
    saveWorld(this.world);
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
      const reactions = await generateReactions(headline, targets);
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
      saveWorld(this.world);
    } catch (err) {
      console.error("LLM error:", err);
      this.log({ kind: "system", participants: [], text: `📣 ${headline} (nobody reacted: ${(err as Error).message})` });
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
    generateLine(speaker, others, chat.pairs, chat.lines.filter((l) => l.speaker), chat.place, USER_CHAT_ONGOING, canLeave)
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
        console.error("LLM error (user chat):", err);
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
    summarizeConversation(chat.allMembers, chat.pairs, spoken, chat.place)
      .then((outcome) => {
        const byName = (n: string) => chat.allMembers.find((c) => c.name === n);
        for (const p of outcome.pairs) {
          const a = byName(p.a), b = byName(p.b);
          if (!a || !b) continue;
          const rel = getRel(this.world, a.id, b.id);
          rel.affinity = Math.max(-100, Math.min(100, rel.affinity + p.affinity_delta));
          rel.label = p.relationship;
          rel.history.push(`Chatting with ${chat.userName} at ${chat.place}: ${outcome.outcomes.find((o) => o.name === a.name)?.memory ?? "a chat"}`);
          if (rel.history.length > 10) rel.history.shift();
        }
        for (const o of outcome.outcomes) {
          const c = byName(o.name);
          if (!c) continue;
          c.mood = o.mood;
          c.memories.push(`(chatting with ${chat.userName}) ${o.memory}`);
          if (c.memories.length > 10) c.memories.shift();
        }
        saveWorld(this.world);
      })
      .catch((err) => console.error("LLM error (user chat summary):", err))
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
        if (this.now >= c.idleUntil) { c.state = "wandering"; c.target = randomWalkable(); }
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
    if (this.chats.length < MAX_CHATS) this.findMeeting();
  }

  private findMeeting() {
    const free = this.world.characters.filter((c) => c.state !== "talking");
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        const a = free[i], b = free[j];
        if (Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) > MEET_DIST) continue;
        const key = relKey(a.id, b.id);
        const rel = getRel(this.world, a.id, b.id);
        if (!this.forced.has(key) && rel.lastTalk && this.now - rel.lastTalk < PAIR_COOLDOWN) continue;
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
      summarizeConversation(chat.members, chat.pairs, chat.lines, chat.place)
        .then((o) => { chat.outcome = o; })
        .catch((err) => {
          console.error("LLM error (summary):", err);
          chat.outcome = { outcomes: [], pairs: [] };
        })
        .finally(() => { chat.generating = false; });
      return;
    }
    // Write at most one line ahead of what's on screen, so the next line is ready when the bubble changes.
    if (chat.lines.length > chat.idx) return;

    const speaker = this.pickSpeaker(chat);
    chat.generating = true;
    generateLine(speaker, chat.present.filter((c) => c !== speaker), chat.pairs, chat.lines, chat.place, MAX_TURNS - chat.lines.length, chat.lines.length >= MIN_LINES_BEFORE_LEAVING)
      .then(({ says, wants_to_leave }) => {
        chat.lines.push({ speaker: speaker.name, text: says });
        chat.lastSpeaker = speaker;
        if (wants_to_leave && chat.lines.length > MIN_LINES_BEFORE_LEAVING) chat.present = chat.present.filter((c) => c !== speaker);
        if (chat.lines.length >= MAX_TURNS || chat.present.length < 2) chat.finished = true;
      })
      .catch((err) => {
        if (chat.lines.length >= 2) { console.error("LLM error (line):", err); chat.finished = true; }
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
    const byName = (n: string) => members.find((c) => c.name === n);
    const changes: string[] = [];
    for (const p of outcome.pairs) {
      const a = byName(p.a), b = byName(p.b);
      if (!a || !b) continue;
      const rel = getRel(this.world, a.id, b.id);
      rel.affinity = Math.max(-100, Math.min(100, rel.affinity + p.affinity_delta));
      rel.label = p.relationship;
      const memory = outcome.outcomes.find((o) => o.name === a.name)?.memory;
      if (memory) {
        rel.history.push(`At ${chat.place}${members.length > 2 ? " (group chat)" : ""}: ${memory}`);
        if (rel.history.length > 10) rel.history.shift();
      }
      changes.push(`${a.name}–${b.name}: ${rel.label} (${p.affinity_delta >= 0 ? "+" : ""}${p.affinity_delta})`);
    }
    for (const p of chat.pairs) p.rel.lastTalk = this.now;
    for (const o of outcome.outcomes) {
      const c = byName(o.name);
      if (!c) continue;
      c.mood = o.mood;
      c.memories.push(`(with ${listNames(members.filter((m) => m !== c))}) ${o.memory}`);
      if (c.memories.length > 10) c.memories.shift();
    }

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
    saveWorld(this.world);
    this.maybeAutoEvent();
  }

  // Roll for a spontaneous event after a random number of completed chats (issue #2).
  private maybeAutoEvent() {
    if (!AUTO_EVENTS) return;
    this.chatsSinceEvent += 1;
    if (this.chatsSinceEvent < this.nextAutoEvent) return;
    if (this.eventBusy || this.now - this.lastAutoEvent < AUTO_COOLDOWN) return;
    this.chatsSinceEvent = 0;
    this.nextAutoEvent = rollNextAuto();
    this.lastAutoEvent = this.now;
    generateEvent(this.recentChats, this.world.characters, LANDMARKS.map((l) => l.name))
      .then((ev) => {
        const target = this.world.characters.find((c) => c.name === ev.target);
        this.log({ kind: "system", participants: [], text: `🎲 The island stirs...` });
        void this.triggerEvent(ev.headline, target?.id ?? null, ev.gather === "nowhere" ? null : ev.gather);
      })
      .catch((err) => console.error("LLM error (auto event):", err));
  }

  private failChat(chat: ActiveChat, err: Error) {
    console.error("LLM error:", err);
    this.log({ kind: "system", participants: chat.members.map((c) => c.id), text: `${listNames(chat.members)} stared at each other awkwardly (LLM error: ${err.message})` });
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

function listNames(cs: Character[]) {
  const n = cs.map((c) => c.name);
  return n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} & ${n[n.length - 1]}`;
}
