import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Tool } from "../types.js";

/**
 * Standard agent-skill layout support.
 *
 * A skill is either:
 *   <dir>/<name>/SKILL.md      (standard: a directory with an entrypoint)
 *   <dir>/<name>.md            (single-file skill, legacy shorthand)
 *
 * SKILL.md carries YAML frontmatter with at least `name` and `description`:
 *   ---
 *   name: aemeath
 *   description: 爱弥斯人格……
 *   ---
 *   # body ...
 *
 * Only name+description go into the system prompt; the body loads on demand via
 * use_skill, and the model can read sibling files with read_file.
 */
export interface Skill {
  /** Skill name (from frontmatter, else the directory/file name). */
  name: string;
  /** One-line description used for discovery. */
  description: string;
  /** Full SKILL.md body (without frontmatter). */
  body: string;
  /** Absolute path of the SKILL.md file. */
  file: string;
  /** Directory containing the skill (for reading sibling resources). */
  dir: string;
  /** Other files shipped with the skill (relative paths), for the model's reference. */
  resources: string[];
  /** Optional license/author metadata from frontmatter. */
  meta: Record<string, string>;
}

/** Parse `---` delimited YAML frontmatter. Handles folded `>` blocks. */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  let key: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (key) meta[key] = buf.join(" ").replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "");
    key = null;
    buf = [];
  };
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (kv) {
      flush();
      key = kv[1];
      const val = kv[2].trim();
      // `key: >` or `key: |` starts a folded block
      if (val === ">" || val === "|") buf = [];
      else buf = [val];
    } else if (key) {
      buf.push(raw.trim());
    }
  }
  flush();
  return { meta, body: text.slice(m[0].length) };
}

/** Discover skills in the given directories (first match wins per name). */
export function discoverSkills(dirs: string[]): Skill[] {
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }

      if (isDir) {
        // Standard layout: <dir>/<name>/SKILL.md
        const skillFile = join(full, "SKILL.md");
        const altFile = join(full, "skill.md");
        const entryFile = existsSync(skillFile) ? skillFile : existsSync(altFile) ? altFile : null;
        if (!entryFile) continue;
        const skill = readSkill(entryFile, full, seen);
        if (skill) out.push(skill);
      } else if (/\.md$/i.test(entry) && entry.toLowerCase() !== "readme.md") {
        // Legacy single-file skill (kept for backwards compatibility).
        const skill = readSkill(full, dir, seen);
        if (skill) out.push(skill);
      }
    }
  }
  return out;
}

function readSkill(file: string, dir: string, seen: Set<string>): Skill | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(text);
  const name = (meta.name || basename(dir) || basename(file).replace(/\.md$/i, "")).trim();
  if (!name || seen.has(name)) return null;
  seen.add(name);
  return {
    name,
    description: meta.description || firstParagraph(body) || "(no description)",
    body,
    file,
    dir,
    resources: listResources(dir),
    meta,
  };
}

function firstParagraph(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("---")) continue;
    return t.slice(0, 200);
  }
  return "";
}

/** Other files in the skill directory (excluding the entrypoint), relative paths. */
function listResources(dir: string, depth = 0): string[] {
  if (depth > 2) return [];
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const e of entries) {
    if (e === "SKILL.md" || e === "skill.md") continue;
    const full = join(dir, e);
    try {
      if (statSync(full).isDirectory()) out.push(...listResources(full, depth + 1).map((r) => `${e}/${r}`));
      else out.push(e);
    } catch {
      /* skip */
    }
  }
  return out.slice(0, 40);
}

/** Compact index injected into the system prompt. */
export function skillsIndex(skills: Skill[]): string {
  if (!skills.length) return "";
  return skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
}

/** The `use_skill` tool: loads a skill body (and lists its resources). */
export function useSkillTool(skills: Skill[]): Tool {
  return {
    name: "use_skill",
    description:
      "Load the full instructions of a named skill. Call this before performing a task a skill covers. " +
      "Returns the skill body plus any bundled resource files you can read with read_file.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name from the available list." },
        resource: {
          type: "string",
          description: "Optional: load a bundled resource file of the skill instead of the body.",
        },
      },
      required: ["name"],
    },
    async execute(input, ctx) {
      const { name, resource } = input as { name: string; resource?: string };
      const s = skills.find((x) => x.name === name);
      if (!s) {
        return {
          content: `未找到技能 "${name}"。可用: ${skills.map((x) => x.name).join(", ")}`,
          isError: true,
        };
      }
      if (resource) {
        // Resolve within the skill directory only.
        const { resolve, relative, isAbsolute } = await import("node:path");
        const target = resolve(s.dir, resource);
        const rel = relative(s.dir, target);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          return { content: `资源路径越界: ${resource}`, isError: true };
        }
        if (!existsSync(target)) {
          return { content: `未找到资源 ${resource}。可用: ${s.resources.join(", ") || "(无)"}`, isError: true };
        }
        try {
          return { content: readFileSync(target, "utf8"), display: { skill: name, resource } };
        } catch {
          return { content: `无法读取资源 ${resource}`, isError: true };
        }
      }
      const resNote = s.resources.length
        ? `\n\n---\n## 本技能附带文件（可用 read_file 读取，路径相对于 ${s.dir}）\n` +
          s.resources.map((r) => `- ${join(s.dir, r)}`).join("\n")
        : "";
      return { content: s.body + resNote, display: { skill: name } };
    },
  };
}
