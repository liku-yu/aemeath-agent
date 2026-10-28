import { mkdir, readFile, writeFile, readdir, rm, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage, ContentBlock, NoteStore } from "../types.js";
import { dataPaths } from "../config/schema.js";

/**
 * Bump when the on-disk session shape changes in a way older readers would
 * misinterpret. Readers MUST refuse a version they do not understand rather
 * than guessing — silently misreading history is worse than an error.
 */
export const SESSION_SCHEMA_VERSION = 1;

/** Rewrite the journal once it grows past this, so it cannot grow without bound. */
const JOURNAL_COMPACT_BYTES = 4 * 1024 * 1024;

/**
 * Session ids become directory names under `<dataDir>/sessions`.
 *
 * `join()` will happily walk back out of that directory (`"../.."`), and
 * `remove()` is recursive — so an unchecked id is an arbitrary-directory delete
 * primitive reachable from an IPC call. Every entry point goes through here.
 *
 * `newId()` emits `[0-9a-z]+-[0-9a-z]+`, so the pattern is deliberately wider
 * than what we generate (to keep ids from older builds readable) but still a
 * plain slug.
 */
function assertSafeSessionId(id: string): string {
  const value = String(id ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) || value === "." || value === "..") {
    throw new Error(`非法的会话 id: ${JSON.stringify(id)}`);
  }
  return value;
}

export interface SessionMeta {
  /** Absent on sessions written before versioning; treated as version 0. */
  schemaVersion?: number;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/**
 * Make every `tool_use` block answered by a `tool_result`.
 *
 * Providers reject an assistant message whose tool_use has no matching
 * tool_result — Anthropic fails the whole request, OpenAI does the same for
 * `tool_calls`. A run interrupted mid-batch (user presses stop, the process
 * dies) leaves exactly that shape in the journal, so every *later* turn in that
 * session fails with an error that looks like a provider problem.
 *
 * The runner also fills in cancelled results when it stops; this repairs history
 * already written by an older build or by a crash.
 */
export function healToolPairs(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    out.push(msg);
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;

    const ids = msg.content.filter((b) => b.type === "tool_use").map((b) => b.id);
    if (!ids.length) continue;

    const next = messages[i + 1];
    const answered = new Set<string>();
    if (next && Array.isArray(next.content)) {
      for (const b of next.content) if (b.type === "tool_result") answered.add(b.toolUseId);
    }
    const missing = ids.filter((id) => !answered.has(id));
    if (!missing.length) continue;

    const synthetic: ContentBlock[] = missing.map((toolUseId) => ({
      type: "tool_result" as const,
      toolUseId,
      content: "（没有返回结果：上一轮被中断）",
      isError: true,
    }));
    if (next && Array.isArray(next.content) && next.content.some((b) => b.type === "tool_result")) {
      out.push({ ...next, content: [...next.content, ...synthetic] });
      i++; // this message has been consumed
    } else {
      out.push({ role: "user", content: synthetic });
    }
  }
  return out;
}

/**
 * Where to cut when summarising old turns.
 *
 * The tail is kept verbatim, so the cut must not land inside a tool exchange: a
 * tail that starts on a tool_result refers to a tool_use that was just folded
 * into the summary, and both providers reject a tool_result with nothing to
 * answer — Anthropic fails the whole request. Walking back one message at a time
 * until the tail starts somewhere clean is cheaper than repairing it later.
 *
 * Returns how many trailing messages to keep (always >= keepMin, at least 1).
 */
export function compactionBoundary(messages: ChatMessage[], keepMin = 6): number {
  let keep = Math.max(1, Math.min(keepMin, messages.length - 1));
  while (keep < messages.length - 1) {
    const first = messages[messages.length - keep]!;
    const orphaned = Array.isArray(first.content) && first.content.some((b) => b.type === "tool_result");
    if (!orphaned) break;
    keep++;
  }
  return keep;
}

/** Bring an older session record up to the current shape. */
function migrateSessionMeta(meta: SessionMeta): SessionMeta {
  let m = meta;
  const from = m.schemaVersion ?? 0;
  switch (from) {
    case 0:
      // v0 → v1: versioning introduced; nothing else changed yet.
      m = { ...m, schemaVersion: 1 };
      break;
    default:
      break;
  }
  return m;
}

/** Thrown when a session was written by a newer build. */
export class SessionVersionError extends Error {
  constructor(readonly id: string, readonly found: number) {
    super(`会话 ${id} 的格式版本为 ${found}，高于当前支持的 ${SESSION_SCHEMA_VERSION}。请升级后再打开。`);
    this.name = "SessionVersionError";
  }
}

/**
 * Session store with incremental NDJSON journaling (one record per appended
 * message) + rebuilt in memory. Mirrors AemeathCode's "append, don't rewrite"
 * approach so a crash never corrupts history.
 */
export class SessionStore {
  readonly id: string;
  private dir: string;
  private messages: ChatMessage[] = [];
  private title = "新会话";
  private createdAt = Date.now();
  private updatedAt = Date.now();

  private constructor(id: string, dir: string) {
    this.id = id;
    this.dir = dir;
  }

  static async create(dataDir: string, opts: { title?: string } = {}): Promise<SessionStore> {
    const id = newId();
    const dir = join(dataPaths(dataDir).sessions, id);
    await mkdir(dir, { recursive: true });
    const s = new SessionStore(id, dir);
    s.title = opts.title ?? "新会话";
    await s.writeMeta();
    return s;
  }

  static async open(dataDir: string, id: string): Promise<SessionStore> {
    const dir = join(dataPaths(dataDir).sessions, assertSafeSessionId(id));
    const s = new SessionStore(id, dir);
    await s.load();
    return s;
  }

  static async list(dataDir: string): Promise<SessionMeta[]> {
    const root = dataPaths(dataDir).sessions;
    if (!existsSync(root)) return [];
    const ids = await readdir(root).catch(() => [] as string[]);
    const metas: SessionMeta[] = [];
    for (const id of ids) {
      try {
        const raw = JSON.parse(await readFile(join(root, id, "meta.json"), "utf8")) as SessionMeta;
        const found = raw.schemaVersion ?? 0;
        if (found > SESSION_SCHEMA_VERSION) continue; // newer build wrote it: don't guess
        metas.push(migrateSessionMeta(raw));
      } catch {
        /* skip unreadable */
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  static async remove(dataDir: string, id: string): Promise<void> {
    const dir = join(dataPaths(dataDir).sessions, assertSafeSessionId(id));
    // Remove the whole session folder. `unlink` only works on files, so we need
    // `rm` with `recursive` — otherwise the directory (and its meta.json) stays
    // on disk and the session reappears after a reload.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  private get journalPath() {
    return join(this.dir, "messages.ndjson");
  }

  private async load() {
    try {
      const raw = JSON.parse(await readFile(join(this.dir, "meta.json"), "utf8")) as SessionMeta;
      const found = raw.schemaVersion ?? 0;
      if (found > SESSION_SCHEMA_VERSION) throw new SessionVersionError(this.id, found);
      const meta = migrateSessionMeta(raw);
      this.title = meta.title;
      this.createdAt = meta.createdAt;
      this.updatedAt = meta.updatedAt;
    } catch (err) {
      // A version mismatch is not recoverable by falling back to defaults —
      // reading a newer format with an older reader would silently corrupt
      // history, so surface it instead of swallowing it.
      if (err instanceof SessionVersionError) throw err;
      /* otherwise: missing/corrupt meta — keep defaults */
    }
    if (existsSync(this.journalPath)) {
      let raw = "";
      try {
        raw = await readFile(this.journalPath, "utf8");
      } catch {
        raw = "";
      }
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec: any;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; /* skip malformed / partially-written trailing line */
        }
        // A compaction marker supersedes everything written before it.
        if (rec && rec.__compacted === true) {
          this.messages = Array.isArray(rec.messages) ? (rec.messages as ChatMessage[]) : [];
          continue;
        }
        if (rec && (rec.role === "user" || rec.role === "assistant" || rec.role === "system")) {
          this.messages.push(rec as ChatMessage);
        }
      }
    }
  }

  private async writeMeta() {
    const meta: SessionMeta = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      messageCount: this.messages.length,
    };
    await writeFile(join(this.dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  }

  async append(msg: ChatMessage): Promise<ChatMessage> {
    const stored: ChatMessage = { ...msg, id: msg.id ?? newId(), ts: msg.ts ?? Date.now() };
    this.messages.push(stored);
    this.updatedAt = Date.now();
    await writeFile(this.journalPath, JSON.stringify(stored) + "\n", { flag: "a" });
    await this.maybeCompactJournal();
    await this.writeMeta();
    return stored;
  }

  /** Replace the entire in-memory history (used after compaction) and journal a marker. */
  async replaceAll(messages: ChatMessage[], summary: string): Promise<void> {
    this.messages = messages;
    this.updatedAt = Date.now();
    // Append a compaction marker so the journal stays append-only.
    await writeFile(
      this.journalPath,
      JSON.stringify({ __compacted: true, summary, at: Date.now(), messages }) + "\n",
      { flag: "a" },
    );
    await this.maybeCompactJournal({ force: true });
    await this.writeMeta();
  }

  /**
   * Rewrite the journal once it has grown well past what it needs to hold.
   *
   * The log is append-only so a crash can never corrupt history, but that also
   * means it only ever grows: each compaction appends a marker while every
   * superseded record stays on disk forever. Left alone, a long-lived session
   * accumulates megabytes that are parsed and thrown away on every open.
   *
   * Safe because the replacement content is exactly the current in-memory
   * history, written to a temp file and renamed into place.
   */
  private async maybeCompactJournal(opts: { force?: boolean } = {}): Promise<void> {
    try {
      const size = (await stat(this.journalPath)).size;
      // `force` is used right after a compaction, where everything except the
      // marker we just wrote is superseded by definition.
      if (!opts.force && size < JOURNAL_COMPACT_BYTES) return;

      const body =
        this.messages.map((m) => JSON.stringify(m)).join("\n") + (this.messages.length ? "\n" : "");
      const tmp = `${this.journalPath}.tmp`;
      await writeFile(tmp, body, "utf8");
      await rename(tmp, this.journalPath);
    } catch {
      // Compaction is an optimisation; never let it break a message append.
    }
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  setTitle(t: string) {
    if (this.title === "新会话" && t) this.title = t.slice(0, 60);
  }

  get meta(): SessionMeta {
    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      messageCount: this.messages.length,
    };
  }
}

/** Notes store — cross-session long-term memories. */
export class JsonNoteStore implements NoteStore {
  constructor(private file: string) {}

  private async all(): Promise<Array<{ title: string; body: string; tags: string[]; ts: number }>> {
    if (!existsSync(this.file)) return [];
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Array<{ title: string; body: string; tags: string[]; ts: number }>;
    } catch {
      return [];
    }
  }

  async save(note: { title: string; body: string; tags?: string[] }) {
    const list = await this.all();
    list.push({ title: note.title, body: note.body, tags: note.tags ?? [], ts: Date.now() });
    await mkdir(join(this.file, ".."), { recursive: true });
    await writeFile(this.file, JSON.stringify(list, null, 2), "utf8");
  }

  async list() {
    return this.all();
  }

  async search(query: string) {
    const q = query.toLowerCase();
    const list = await this.all();
    return list.filter(
      (n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q) || n.tags.some((t) => t.includes(q)),
    );
  }
}

export function newId(): string {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

/** Rough token estimate: ~4 chars/token for mixed CJK+ASCII text. */
export function estimateTokens(messages: ChatMessage[], system: string): number {
  const size = (c: string | ContentBlock[]) => {
    if (typeof c === "string") return c.length;
    let n = 0;
    for (const b of c) {
      if (b.type === "text") n += b.text.length;
      else if (b.type === "reasoning") n += b.text.length;
      else if (b.type === "tool_use") n += JSON.stringify(b.input ?? {}).length + b.name.length;
      else n += b.content.length + 40;
    }
    return n;
  };
  let chars = system.length;
  for (const m of messages) chars += size(m.content);
  return Math.ceil(chars / 3.2);
}
