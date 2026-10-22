/*
 * Aemeath pet behaviour — a small state machine on top of aemeath-sprite.js.
 *
 * Modelled on the reference pet's behaviour table:
 *   idle / agent running / waiting for input / task error / task start / task done
 *   plus self-directed idle behaviour (random look-around, waving, strolling).
 *
 * The machine owns a base animation (driven by agent mood) and an optional
 * one-shot override (wave / jump / fail), which auto-returns to the base once
 * the sprite reports it has finished. Timing comes from the sprite's variable
 * per-frame durations.
 */
(function () {
  const BASE_FOR_MOOD = {
    idle: "idle",
    thinking: "review",
    working: "running",
    waiting: "waiting",
    happy: "idle", // celebrate via the one-shot jump
    error: "failed",
  };

  /** Idle self-directed actions: [anim, weight]. */
  const IDLE_ACTIONS = [
    ["waving", 3],
    ["jumping", 2],
    ["running-left", 2],
    ["running-right", 2],
  ];

  function createPet() {
    let baseAnim = "idle";
    let override = null; // { anim, startedAt }
    let startedAt = performance.now();
    /** idle | thinking | working | waiting | happy | error | hurt | greeting */
    let mood = "idle";
    let paused = false;
    let idleTimer = 0;
    let nextIdleActionAt = 0;

    function now() {
      return performance.now();
    }

    function setBase(anim) {
      if (baseAnim === anim) return;
      baseAnim = anim;
      if (!override) startedAt = now();
    }

    /** Play a one-shot animation on top of the current base. */
    function play(anim) {
      if (!window.AemeathSprite.isOneShot(anim)) return;
      override = { anim, startedAt: now() };
    }

    /** Change mood (from agent events). */
    function setMood(next) {
      mood = next;
      setBase(BASE_FOR_MOOD[next] || "idle");
      if (next === "happy") play("jumping");
      else if (next === "error") play("failed");
      else if (next === "greeting") play("waving");
    }

    function setPaused(p) {
      paused = p;
      if (p) startedAt = now();
    }

    function pickIdleAction() {
      const total = IDLE_ACTIONS.reduce((s, a) => s + a[1], 0);
      let r = Math.random() * total;
      for (const [anim, w] of IDLE_ACTIONS) {
        r -= w;
        if (r <= 0) return anim;
      }
      return IDLE_ACTIONS[0][0];
    }

    /** The animation + elapsed time to render right now. */
    function current() {
      const t = now();
      // One-shot finished → drop it.
      if (override && window.AemeathSprite.isFinished(override.anim, t - override.startedAt)) {
        override = null;
        startedAt = t;
      }
      if (override) return { anim: override.anim, elapsed: t - override.startedAt };
      return { anim: baseAnim, elapsed: t - startedAt };
    }

    /**
     * Advance timers. `active` = the agent is doing something, in which case we
     * never self-direct (she should look busy, not wander off).
     */
    function update(dtMs, active) {
      if (paused || override || active) {
        nextIdleActionAt = 0;
        return;
      }
      // Schedule the next self-directed action 4-9s from now.
      if (nextIdleActionAt === 0) {
        nextIdleActionAt = now() + 4000 + Math.random() * 5000;
        return;
      }
      if (now() >= nextIdleActionAt) {
        play(pickIdleAction());
        nextIdleActionAt = 0;
      }
    }

    return {
      setMood,
      play,
      setPaused,
      current,
      update,
      get anim() {
        return override ? override.anim : baseAnim;
      },
      get mood() {
        return mood;
      },
    };
  }

  window.AemeathPet = { create: createPet, BASE_FOR_MOOD, IDLE_ACTIONS };
})();
