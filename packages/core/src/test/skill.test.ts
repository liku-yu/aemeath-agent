import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findAemeathSkillDir } from "./skill-locate.js";

const skillDir = findAemeathSkillDir(dirname(fileURLToPath(import.meta.url)));


function allSkillText(): string {
  return readdirSync(skillDir!)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(skillDir!, f), "utf8"))
    .join("\n");
}

/**
 * These were WRONG in earlier community-derived notes and are corrected by the
 * official (moegirlpedia) entry. They must never come back as facts.
 * A mention is only acceptable inside a "this was wrong" correction table.
 */
const SUPERSEDED = ["落剑湖", "隧者同步实验", "400%"];

test("skill does not assert superseded fan-transcription facts", () => {
  const text = allSkillText();
  for (const bad of SUPERSEDED) {
    if (!text.includes(bad)) continue;
    // Allowed only in conflicts.md's correction table, next to a ❌ marker.
    const idx = text.indexOf(bad);
    const window = text.slice(Math.max(0, idx - 200), idx + 200);
    assert.match(
      window,
      /❌|旧（错误）|已更正|修正|错误/,
      `"${bad}" is asserted as a fact; it should only appear as a corrected mistake`,
    );
  }
});

test("skill contains the official setting facts", () => {
  const text = allSkillText();
  const required = [
    "渐湖",          // correct drowning location
    "超频共鸣",      // correct cause of losing her body
    "驾驶课",        // official framing
    "金瞳",          // official eye colour
    "热熔",          // official resonance attribute
    "迅刀",          // official weapon type
    "长航的星辉",    // official ability name
    "飞行雪绒",      // her idol alias
    "拉贝尔学部",    // her department
    "磁暴研究员",    // her parents' profession
    "琳奈",          // classmate
    "西格莉卡",      // classmate
    "千咲",          // classmate
    "辛吉勒姆",      // the Threnodian she fought
    "阿列夫一",      // the high-dimensional Threnodian
    "隧门",          // key location
    "炉芯",          // key object
    "靛青宇宙",      // her EP
    "只要抬头，那颗星总能找到我", // canonical line
  ];
  for (const fact of required) {
    assert.ok(text.includes(fact), `missing official fact: ${fact}`);
  }
});

test("relations states family (not lovers) as the official bond", () => {
  const rel = readFileSync(join(skillDir!, "relations.md"), "utf8");
  assert.match(rel, /家人/);
  assert.match(rel, /(不是|不作|不把).{0,12}恋爱|恋爱向/);
});

test("SKILL.md frontmatter is valid and declares the skill name", () => {
  // Normalise line endings: skills authored on Windows are CRLF, and the
  // frontmatter parser must not care.
  const skill = readFileSync(join(skillDir!, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
  assert.match(skill, /^---\n/);
  assert.match(skill, /name:\s*aemeath/);
  assert.match(skill, /description:/);
});


test("skill ships the verbatim voice lines from the official source", () => {
  const dir = findAemeathSkillDir(dirname(fileURLToPath(import.meta.url)));
  assert.ok(dir, "skill dir not found");
  const voice = readFileSync(join(dir!, "voice.md"), "utf8");
  // Canonical first-person lines — these are the most reliable guide to her voice.
  const must = [
    "爱弥斯，拉贝尔学部的隧者适格者！",   // self-introduction
    "现在的我，是电子幽灵哦~",
    "我想和你一样，成为救世主。",
    "隧者兵装：自检开始",
    "无论你在这世上走多远",
    "要轻松快乐地活着",
    "人生除死无大事",
    // Relationship lines (the second batch of voice.json)
    "一视同仁的温柔杀伤力真是可怕呀",
    "陆医生是个有能力的好人",
    "一直守望着你的平静与安宁",
    "椿姐姐和我一起在冰原上追着隧群跑过",
    "你为何……能够这样选择",
  ];
  for (const line of must) {
    assert.ok(voice.includes(line), `voice.md must contain the official line: ${line}`);
  }
  // It must also spell out the speaking grammar we inferred, not just dump lines.
  assert.match(voice, /说话语法/);
});

test("skill records the official Kuro-wiki facts", () => {
  const dir = findAemeathSkillDir(dirname(fileURLToPath(import.meta.url)));
  const all = readdirSync(dir!)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(dir!, f), "utf8"))
    .join("\n");
  for (const fact of [
    "超级豹风雪",
    "太空战士卡佳VI",
    "隧者手办",
    "自然型共鸣者",
    "萨迦教授",
    "陆·赫斯",
    "莫宁",
    "守岸人",
    "椿",
    "隧者",
  ]) {
    assert.ok(all.includes(fact), `missing official fact: ${fact}`);
  }
});
