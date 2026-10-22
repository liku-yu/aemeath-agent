import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Locate the `aemeath` skill directory the same way the app does at runtime.
 *
 * The persona is versioned with the repository (`skills/aemeath/`) and that copy
 * is the only source of truth — no user-level duplicate is kept, so the two
 * cannot drift. The user-level lookup below stays as a fallback for machines
 * running a build without the repo checkout.
 */
export function findAemeathSkillDir(startDir: string): string | null {
  // 1) Project-local, walking up from the test file.
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "skills", "aemeath");
    if (existsSync(join(candidate, "SKILL.md"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 2) User-level (global) skill directory.
  const global = join(homedir(), ".aemeath", "skills", "aemeath");
  if (existsSync(join(global, "SKILL.md"))) return global;
  return null;
}
