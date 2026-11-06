import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(path.join(web, "static/app.js"), "utf8");
const sfxSource = readFileSync(path.join(web, "static/sfx.mjs"), "utf8");

test("the hit sound is cursor3 on floating-block activation, decide3 on crush", () => {
  assert.match(app, /case "activated":/);
  assert.match(app, /sfx\.hitBlock\(\)/);
  assert.match(sfxSource, /hitBlock\(\) \{\s*play\("cursor3"\);/);
  assert.match(sfxSource, /hitCrush\(\) \{\s*play\("decide3"\);/);
  // The first-hit tick (call07) and the level-up fanfare (power14) are gone.
  assert.doesNotMatch(app, /"call07", "power14"/);
  assert.doesNotMatch(sfxSource, /play\("call07"\)/);
  assert.doesNotMatch(sfxSource, /play\("power14"\)/);
  assert.doesNotMatch(app, /sfx\.touchTick/);
  assert.doesNotMatch(app, /sfx\.levelUp/);
  assert.doesNotMatch(app, /sfx\.hitTick/);
});

test("the level system is retired from the surface", () => {
  assert.doesNotMatch(app, /case "level_changed"/);
  assert.doesNotMatch(app, /LEVEL \$\{event\.value\}/);
  assert.doesNotMatch(app, /· level/);
  assert.match(app, /"level_completed" \? "Complete"/);
});

test("score digits use the mode's ranking strip", () => {
  assert.match(app, /"ranking_num_ex" : "ranking_num"/);
  assert.doesNotMatch(app, /num_score/);
});

test("walls: metsu sprites only, plain white fixtures in normal mode", () => {
  assert.match(app, /gameMode === "metsu" && assetsReady && sprites\.has\("field_l"\)/);
  assert.match(app, /side_wall_top/);
  assert.match(app, /side_wall_bottom/);
  assert.match(app, /fillRect\(f\.x, top, thick, wallHeight\)/);
});

test("ending sequences play the result music and fade the girl in", () => {
  assert.match(app, /GIRL_IDLE_ALPHA = 70/);
  assert.match(app, /bgm\/irisu_gos1\.mp3/);
  assert.match(app, /bgm\/i_go05A\.mp3/);
  assert.match(app, /bgm\/i_go03B\.mp3/);
  assert.match(app, /< 20000 \? "back2" : "back1"/);
  assert.match(app, /back1_ex3/);
  assert.match(app, /back1_ex2/);
  assert.match(app, /persist: true/);
  assert.match(app, /girlFadeInProgress\(\)/);
});
