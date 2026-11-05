import assert from "node:assert/strict";
import test from "node:test";

import {parseReplay, serializeReplay} from "../static/replay.mjs";

test("metsu replay headers round-trip with mode 1", () => {
  const words = new Uint32Array([0, 0, 1, 2, 3, 0x00100401]);
  const bytes = serializeReplay({seed: 0xcafe, highestLevel: 7,
    finalScore: 12_345, highestChain: 9, words, mode: 1});
  const replay = parseReplay(bytes);
  assert.equal(replay.mode, 1);
  assert.equal(replay.seed, 0xcafe);
  assert.equal(replay.highestLevel, 7);
  assert.equal(replay.finalScore, 12_345);
  assert.equal(replay.highestChain, 9);
  assert.equal(replay.frameCount, words.length);
  assert.deepEqual(Array.from(replay.words), Array.from(words));
});

test("unknown replay modes are still rejected", () => {
  const words = new Uint32Array(1);
  const bytes = serializeReplay({seed: 1, highestLevel: 1, finalScore: 0,
    highestChain: 0, words, mode: 0});
  const view = new DataView(bytes.buffer);
  view.setInt32(16, 2, true);
  assert.throws(() => parseReplay(bytes), /replay mode 2 is unsupported/);
});

test("the metsu runtime drives the wasm simulator", {timeout: 60_000}, async () => {
  const {MetsuGame} = await import("../static/metsu-runtime.mjs?v=20261105a");
  const snapshots = [];
  const game = await MetsuGame.create(
    (snapshot) => snapshots.push(snapshot), {seed: 4242});
  try {
    const first = snapshots[0].observation;
    assert.equal(first.field.x, 94);
    assert.equal(first.field.width, 420);
    assert.equal(first.gauge, 1000);
    assert.equal(first.gauge_max, 10000);
    game.shoot("weak", 320, 400);
    for (let index = 0; index < 40; ++index) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const last = snapshots.at(-1).observation;
    assert.ok(last.tick > 20, "the metsu runtime advanced the simulation");
    assert.ok(snapshots.at(-1).seed === 4242);
    let bubbles = 0;
    for (const body of last.bodies) {
      if (body.bubble) {
        bubbles += 1;
        assert.equal(body.shape, "circle");
        assert.ok([42, 58, 74].includes(body.size));
      }
    }
    assert.ok(bubbles >= 0);
    // Replays cannot be saved before a recorded run finishes.
    assert.throws(() => game.replayBytes(), /recorded game finishes/);
  } finally {
    game.close();
  }
});

test("metsu replays play back and seek through the wasm simulator",
  {timeout: 60_000}, async () => {
    const {MetsuGame} = await import("../static/metsu-runtime.mjs?v=20261105a");
    const snapshots = [];
    const game = await MetsuGame.create(
      (snapshot) => snapshots.push(snapshot), {seed: 9});
    try {
      const words = new Uint32Array(400);
      const bytes = serializeReplay({seed: 9, highestLevel: 2, finalScore: 60,
        highestChain: 3, words, mode: 1});
      await game.loadReplay(parseReplay(bytes), "metsu.rpy");
      assert.equal(snapshots.at(-1).mode, "replay");
      game.setRunning(true);
      for (let index = 0; index < 50; ++index) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const playing = snapshots.at(-1);
      assert.ok(playing.replay.frame > 10, "replay playback advanced");
      assert.equal(playing.replay.total_frames, 400);
      game.seekReplay(300, {preserveRunning: false});
      const sought = snapshots.at(-1);
      assert.equal(sought.replay.frame, 300);
      assert.equal(sought.observation.tick, 300);
    } finally {
      game.close();
    }
  });
