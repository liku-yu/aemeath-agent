import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { newId } from "../memory/session.js";

/**
 * Checkpoint store — snapshots files before the agent mutates them so any
 * turn can be rolled back.
 *
 * Layout under <dataDir>/checkpoints/<sessionId>/:
 *   <seq>-<id>.json   metadata: { id, label, ts, files: [{ path, existed, bak }] }
 *   blobs/<hash>      original file contents
 *
 * Restoring rewrites the pre-edit contents (or deletes files that did not exist).
 */
export interface CheckpointFile {
  /** Absolute path at capture time. */
  path: string;
  /** Relative path for display. */
  rel: string;
  /** Whether the file existed before the edit. */
  existed: boolean;
  /** Blob filename holding the original contents (when existed). */
  bak?: string;
}

export interface Checkpoint {
  id: string;
  label: string;
  ts: number;
  files: CheckpointFile[];
}

export class CheckpointStore {
  private dir: string;

  constructor(dataDir: string, private sessionId: string) {
    this.dir = join(dataDir, "checkpoints", sessionId);
  }

  /** Open (or create) the checkpoint store for a session. */
  static open(dataDir: string, sessionId: string): CheckpointStore {
    const store = new CheckpointStore(dataDir, sessionId);
    mkdirSync(join(store.dir, "blobs"), { recursive: true });
    return store;
  }

  private get blobsDir() {
    return join(this.dir, "blobs");
  }

  /**
   * Capture the current state of `paths` into a new checkpoint.
   * Returns the checkpoint (already persisted).
   */
  create(label: string, paths: string[], cwd: string): Checkpoint {
    const id = newId();
    const files: CheckpointFile[] = [];
    for (const abs of paths) {
      const existed = existsSync(abs);
      let bak: string | undefined;
      if (existed) {
        bak = `${id}-${files.length}.bak`;
        try {
          copyFileSync(abs, join(this.blobsDir, bak));
        } catch {
          bak = undefined;
        }
      }
      files.push({ path: abs, rel: relative(cwd, abs).split("\\").join("/"), existed, bak });
    }
    const cp: Checkpoint = { id, label, ts: Date.now(), files };
    this.write(cp);
    return cp;
  }

  private write(cp: Checkpoint) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${cp.ts}-${cp.id}.json`), JSON.stringify(cp, null, 2), "utf8");
  }

  /** All checkpoints, newest last. */
  list(): Checkpoint[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Checkpoint;
        } catch {
          return null;
        }
      })
      .filter((c): c is Checkpoint => !!c)
      .sort((a, b) => a.ts - b.ts);
  }

  /**
   * Restore a checkpoint. With `latest`, restores the newest one.
   * Returns the restored checkpoint, or null when there is nothing to undo.
   */
  restore(idOrLatest: string): Checkpoint | null {
    const all = this.list();
    if (!all.length) return null;
    const cp =
      idOrLatest === "latest"
        ? all[all.length - 1]
        : all.find((c) => c.id === idOrLatest || c.id.startsWith(idOrLatest));
    if (!cp) return null;

    for (const f of cp.files) {
      try {
        if (f.existed && f.bak) {
          mkdirSync(dirname(f.path), { recursive: true });
          copyFileSync(join(this.blobsDir, f.bak), f.path);
        } else if (!f.existed && existsSync(f.path)) {
          // The agent created this file; undo means removing it.
          rmSync(f.path, { force: true });
        }
      } catch {
        /* best-effort per file */
      }
    }

    // Drop this checkpoint and anything after it (the timeline moved back).
    const idx = all.findIndex((c) => c.id === cp.id);
    for (const c of all.slice(idx)) {
      try {
        rmSync(join(this.dir, `${c.ts}-${c.id}.json`), { force: true });
      } catch {
        /* ignore */
      }
    }
    return cp;
  }

  /** Remove all checkpoints for this session. */
  clear() {
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Resolve a possibly-relative path against cwd (no escape check — callers do that). */
export function absPath(cwd: string, p: string): string {
  return p.startsWith(".") ? resolve(cwd, p) : p;
}
