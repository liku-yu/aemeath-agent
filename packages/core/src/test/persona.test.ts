import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPersona, buildSystemPrompt } from "../persona/persona.js";
import { findAemeathSkillDir } from "./skill-locate.js";
import { defaultConfig } from "../config/schema.js";

/**
 * The persona must actively fight "AI voice". These are the phrases that make
 * replies sound like a support bot. They may only appear inside the
 * "forbidden" lists that tell the model NOT to use them.
 */
const AI_TELLS = [
  "作为一个助手",
  "作为语言模型",
  "我可以帮你",
  "非常好的问题",
  "希望这些对你有帮助",
  "如果还有问题随时",
  "值得注意的是",
];

const persona = loadPersona(defaultConfig());

test("persona forbids AI-assistant phrasing", () => {
  for (const tell of AI_TELLS) {
    if (!persona.includes(tell)) continue;
    // If present, it must be in a prohibition context (禁用/禁止/不要/不用).
    // The ban header can be a fair distance above the individual phrases.
    const idx = persona.indexOf(tell);
    const window = persona.slice(Math.max(0, idx - 400), idx + 40);
    assert.match(
      window,
      /禁|不要|不用|避免|禁止/,
      `"${tell}" appears without a prohibition nearby`,
    );
  }
});

test("persona actively requires human speech markers", () => {
  // Must explicitly ban assistant tone and demand short/broken sentences.
  assert.match(persona, /说人话|去\s*AI|AI\s*腔/i);
  assert.match(persona, /短句/);
  assert.match(persona, /(自我修正|打断)/);
});

test("system prompt keeps anti-AI instructions", () => {
  const prompt = buildSystemPrompt({ ...defaultConfig(), cwd: process.cwd() }, { tools: ["read_file"] });
  assert.match(prompt, /说人话/);
  assert.match(prompt, /禁止/);
});

test("interaction skill ships concrete good/bad contrasts", () => {
  const dir = findAemeathSkillDir(dirname(fileURLToPath(import.meta.url)));
  assert.ok(dir, "could not locate the aemeath skill (project or ~/.aemeath)");
  const skill = readFileSync(join(dir!, "interaction.md"), "utf8");
  // The technique that actually works: show the bad version next to the good one.
  assert.match(skill, /❌/);
  assert.match(skill, /✅/);
  const goodCount = (skill.match(/✅/g) ?? []).length;
  assert.ok(goodCount >= 6, `expected >=6 contrast examples, found ${goodCount}`);
  // And it must name the concrete banned phrases.
  assert.match(skill, /作为一个助手/);
  assert.match(skill, /希望这些对你有帮助/);
});
