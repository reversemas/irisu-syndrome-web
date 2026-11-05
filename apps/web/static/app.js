import {BrowserGame} from "./exact-runtime.js?v=20261006e";
import {MetsuGame} from "./metsu-runtime.mjs?v=20261105a";
import {
  activatedTrailAlphas, colorFor, hasActivatedTrail,
} from "./colors.mjs?v=20261105a";
import {
  clampReplayScrubFrame, parseReplay, REPLAY_TICK_MS,
} from "./replay.mjs?v=20261105a";
import {RestartGate} from "./restart-gate.mjs?v=20261006e";
import {createSoundtrack} from "./music.mjs?v=20261006e";
import {offlineStatus} from "./offline.mjs?v=20261103a";
import {SpriteBank, blockSpriteName, blockRenderState} from "./sprites.mjs?v=20261106a";
import {createSfx} from "./sfx.mjs?v=20261106a";

const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d", {alpha: false});
const $ = (selector) => document.querySelector(selector);
const ui = {
  over: $("#gameOver"), again: $("#againButton"), finalTitle: $("#finalTitle"),
  finalScore: $("#finalScore"),
  paused: $("#paused"), pause: $("#pauseButton"), restart: $("#restartButton"),
  app: $(".app"), openReplay: $("#openReplayButton"),
  replayFile: $("#replayFileInput"), saveReplay: $("#saveReplayButton"),
  replayControls: $("#replayControls"), replayName: $("#replayName"),
  replayStatus: $("#replayStatus"), replayError: $("#replayError"),
  replayAnnouncement: $("#replayAnnouncement"),
  replayPlay: $("#replayPlayButton"), replayBack: $("#replayBackButton"),
  replayForward: $("#replayForwardButton"), replayScrubber: $("#replayScrubber"),
  replaySpeed: $("#replaySpeed"), replayPosition: $("#replayPosition"),
  exitReplay: $("#exitReplayButton"),
  runtimeLoading: $("#runtimeLoading"),
  shotButtons: document.querySelectorAll("[data-shot]"),
  fastForward: $("#fastForwardButton"),
  mute: $("#muteButton"),
  modeSwitch: $("#modeSwitchButton"),
  appError: $("#appError"),
  toast: $("#toast"),
};

let snapshot = null;
let previousObservation = null;
let snapshotTime = performance.now();
let aim = {x: 320, y: 390, visible: false};
let started = false;
let lastEvent = -1;
let toastTimer;
let fastForwardTimer;
let touchShot = "weak";
let game = null;
let gameMode = "normal";
let switchingMode = false;
let trailTick = -1;
let replayLoadEpoch = 0;
let lastReplayAnnouncement = "";
let replayScrubbing = false;
let replayScrubTarget = null;
const bodyTrails = new Map();
const bodyPositions = new Map();
const pendingScores = [];
const scorePopups = [];
const burstEffects = [];    // expanding sprite ghosts on burst
const popEffects = [];      // bubble pop rings
const shotKindById = new Map();  // body id -> "sball" | "fball"
const soundtrack = createSoundtrack(document, window);
const sprites = new SpriteBank("assets");
const sfx = createSfx({volume: .8});
let assetsReady = false;

// Chain estimate for the burst fanfare: the original pitches se_c1 by
// max(min(group chain, 8)) across the frame's contacts. The observation does
// not carry group chains for block bursts, so we approximate with the burst
// size of the frame (exact for bubble pops via the event value).
let frameBurstCount = 0;

async function loadAssets() {
  try {
    await Promise.all([
      sprites.load(),
      sfx.preload(["buble02", "buble03", "cursor3", "puu89", "decide3",
        "decide10", "decide12", "call07", "power14"]),
    ]);
    assetsReady = true;
    dirty = true;
  } catch (_) { /* vector fallback rendering stays available */ }
}
void loadAssets();

// The AudioContext must be created from a user gesture; the first pointer
// press on the canvas also unlocks the sfx engine alongside the soundtrack.
function unlockAudio() {
  sfx.unlock();
}
window.addEventListener("pointerdown", unlockAudio, {once: true});
window.addEventListener("keydown", unlockAudio, {once: true});

const restartGate = new RestartGate((pending) => {
  if (ui.runtimeLoading) ui.runtimeLoading.hidden = !pending;
  ui.restart.disabled = pending;
  ui.again.disabled = pending;
  ui.openReplay.disabled = pending || !game;
});

const fastForwardIdleMs = 160;
const replaySkipFrames = 5_000 / REPLAY_TICK_MS;

function stopFastForward() {
  clearTimeout(fastForwardTimer);
  fastForwardTimer = 0;
  game?.setFastForward(false);
}

function startFastForward() {
  if (!snapshot?.running) return;
  clearTimeout(fastForwardTimer);
  fastForwardTimer = 0;
  game?.setFastForward(true);
}

function continueFastForward() {
  startFastForward();
  fastForwardTimer = setTimeout(stopFastForward, fastForwardIdleMs);
}

function showToast(text, ms = 1200) {
  ui.toast.textContent = text;
  ui.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("show"), ms);
}

// Tell the player when the app is fully stored for offline play, and when the
// system has cleared that storage (iOS can do this under storage pressure).
async function watchOffline() {
  if (!("serviceWorker" in navigator) || !window.caches || !location.protocol.startsWith("http")) return;
  try { await navigator.storage?.persist?.(); } catch (_) { /* optional */ }
  const flag = "irisu:offline-ready";
  let wasReady = false;
  try { wasReady = localStorage.getItem(flag) === "1"; } catch (_) { /* storage unavailable */ }
  for (let attempt = 0; attempt < 14; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 5000 : 10000));
    let status;
    try { status = await offlineStatus(window, soundtrack.trackCount()); } catch (_) { return; }
    document.documentElement.dataset.offline = status.ready ? "ready" : "partial";
    if (status.ready) {
      if (!wasReady) {
        try { localStorage.setItem(flag, "1"); } catch (_) { /* storage unavailable */ }
        showToast("Ready for offline play", 2600);
      }
      return;
    }
  }
  if (wasReady) {
    try { localStorage.removeItem(flag); } catch (_) { /* storage unavailable */ }
    showToast("Offline files were cleared. Stay online to download them again.", 5000);
  }
}

function showPersistentError(text = "") {
  ui.appError.textContent = text;
  ui.appError.hidden = !text;
}

function announceReplay(key, text) {
  if (key === lastReplayAnnouncement) return;
  lastReplayAnnouncement = key;
  ui.replayAnnouncement.textContent = text;
}

function acceptSnapshot(next, force = false) {
  force ||= Boolean(snapshot && next?.mode !== snapshot.mode);
  force ||= next?.mode === "replay" && snapshot?.mode === "replay" &&
    next.replay.frame < snapshot.replay.frame;
  if (!force && snapshot && next.seed === snapshot.seed &&
      next.observation.tick < snapshot.observation.tick) return;
  if (force || !snapshot || next.seed !== snapshot.seed ||
      next.observation.tick < trailTick) {
    bodyTrails.clear();
    bodyPositions.clear();
    pendingScores.length = 0;
    scorePopups.length = 0;
    burstEffects.length = 0;
    popEffects.length = 0;
    shotKindById.clear();
    trailTick = -1;
  }
  if (next.observation.tick !== trailTick) {
    const active = new Set();
    for (const body of next.observation.bodies) {
      bodyPositions.set(body.id, body);
      if (!hasActivatedTrail(body)) continue;
      active.add(body.id);
      const trail = bodyTrails.get(body.id) || [];
      trail.push({x: body.x, y: body.y, angle: body.angle || 0});
      if (trail.length > activatedTrailAlphas.length + 1) trail.shift();
      bodyTrails.set(body.id, trail);
    }
    for (const id of bodyTrails.keys()) {
      if (!active.has(id)) bodyTrails.delete(id);
    }
    trailTick = next.observation.tick;
  }
  previousObservation = force ? null : snapshot?.observation || next.observation;
  snapshot = next;
  snapshotTime = performance.now();
  dirty = true;
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(640, (event.clientX - rect.left) * 640 / rect.width)),
    y: Math.max(0, Math.min(480, (event.clientY - rect.top) * 480 / rect.height)),
  };
}

function shoot(kind = "weak") {
  if (!snapshot || snapshot.observation.terminated || snapshot.observation.truncated) return;
  soundtrack.start();
  started = true;
  try { game?.shoot(kind, aim.x, aim.y); }
  catch (error) { showToast(error.message); }
}

function setRunning(running) {
  if (!game) return;
  if (running) soundtrack.start();
  if (!running) stopFastForward();
  game.setRunning(running);
  started ||= running;
  syncUi();
}

function syncModeUi() {
  once("gameMode", gameMode, (v) => { document.documentElement.dataset.gameMode = v; });
  once("modeSwitchLabel", gameMode === "normal" ? "metsu mode" : "normal mode", (v) => {
    ui.modeSwitch.firstChild.textContent = v;
  });
  ui.modeSwitch.setAttribute("aria-pressed", String(gameMode === "metsu"));
}

async function createGame(mode) {
  if (mode === "metsu") return MetsuGame.create(receiveSnapshot);
  return BrowserGame.create(receiveSnapshot);
}

async function switchMode(mode) {
  if (switchingMode || mode === gameMode) return;
  switchingMode = true;
  const previousMode = gameMode;
  stopFastForward();
  ui.modeSwitch.disabled = true;
  ui.openReplay.disabled = true;
  if (ui.runtimeLoading) ui.runtimeLoading.hidden = false;
  try {
    const previous = game;
    game = null;
    try { previous.close?.(); } catch (_) { /* swap races are fine */ }
    gameMode = mode;
    game = await createGame(mode);
    game.setAim(aim.x, aim.y);
    started = true;
    lastEvent = -1;
    once("backend", mode === "metsu" ? "portable-wasm" : "exact-v86", (v) => {
      document.documentElement.dataset.backend = v;
    });
    syncModeUi();
    showToast(mode === "metsu" ? "METSU mode" : "NORMAL mode");
  } catch (error) {
    gameMode = previousMode;
    try { game = await createGame(previousMode); }
    catch (fatal) { receiveSnapshot(null, fatal); }
    receiveSnapshot(null, error);
  } finally {
    switchingMode = false;
    ui.modeSwitch.disabled = false;
    ui.openReplay.disabled = !game;
    if (ui.runtimeLoading) ui.runtimeLoading.hidden = true;
  }
}

ui.modeSwitch.addEventListener("click", () => {
  void switchMode(gameMode === "normal" ? "metsu" : "normal");
});

async function restart() {
  if (!game) return false;
  return restartGate.run(async () => {
    replayLoadEpoch++;
    replayScrubbing = false;
    replayScrubTarget = null;
    stopFastForward();
    ui.replayError.hidden = true;
    showPersistentError();
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const restarted = await game.restart(seed);
    if (restarted) {
      started = true;
      lastEvent = -1;
    }
    return restarted;
  });
}

function replayFilename(state) {
  const now = new Date();
  const part = value => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}_` +
    `${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
  const score = Math.max(0, state.score).toString().padStart(8, "0").slice(-8);
  return `${gameMode === "metsu" ? "metsu" : "irisu"}_${score}_${stamp}_0.rpy`;
}

function saveReplay() {
  if (!game || !snapshot?.can_save_replay) return;
  try {
    const data = game.replayBytes();
    const url = URL.createObjectURL(new Blob([data], {type: "application/octet-stream"}));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = replayFilename(snapshot.observation);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    showToast(`saved ${anchor.download}`);
  } catch (error) {
    showToast(error.message);
  }
}

async function openReplayFile(file) {
  const epoch = ++replayLoadEpoch;
  replayScrubbing = false;
  replayScrubTarget = null;
  stopFastForward();
  ui.replayError.hidden = true;
  showPersistentError();
  ui.openReplay.disabled = true;
  ui.replayStatus.textContent = "Loading exact replay…";
  announceReplay("loading", "Loading exact replay");
  try {
    const replay = parseReplay(await file.arrayBuffer());
    if (epoch !== replayLoadEpoch) return;
    const replayModeName = replay.mode === 1 ? "metsu" : "normal";
    if (replayModeName !== gameMode) await switchMode(replayModeName);
    if (epoch !== replayLoadEpoch) return;
    const loaded = await game.loadReplay(replay, file.name || "replay.rpy");
    if (!loaded || epoch !== replayLoadEpoch) return;
    showPersistentError();
    started = true;
    lastEvent = Number.MAX_SAFE_INTEGER;
    syncUi();
  } catch (error) {
    if (epoch !== replayLoadEpoch) return;
    ui.replayError.textContent = error.message;
    ui.replayError.hidden = false;
    ui.replayControls.hidden = false;
    showPersistentError(error.message);
    showToast(error.message);
  } finally {
    if (epoch === replayLoadEpoch) ui.openReplay.disabled = !game;
  }
}

function bodyPath(body, size) {
  ctx.beginPath();
  if (body.shape === "circle") ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
  else if (body.shape === "triangle") {
    ctx.moveTo(-size / 2, -size / 2);
    ctx.lineTo(-size / 2, size / 2);
    ctx.lineTo(size / 2, size / 2);
    ctx.closePath();
  } else ctx.rect(-size / 2, -size / 2, size, size);
}

function fillBody(body, size, color, pose, alpha = 1) {
  ctx.save();
  ctx.translate(pose.x, pose.y);
  ctx.rotate(pose.angle || 0);
  ctx.globalAlpha = alpha;
  bodyPath(body, size);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

// Original background selection, reversed from the Field background changer
// (0x405740..): normal starts on back1, moves to back2 once the music state
// reaches 4, and to back3 above 40000 points; metsu uses the back1_ex family.
function backgroundName(state) {
  if (gameMode === "metsu") {
    if (state.score > 100000) return "back1_ex3";
    if (state.score > 20000) return "back1_ex2";
    return "back1_ex";
  }
  if (state.score > 40000) return "back3";
  if (state.level >= 9) return "back2";
  return "back1";
}

function drawBodySprite(body, pose, now) {
  const metsu = gameMode === "metsu";
  const state = blockRenderState(body, metsu);

  // Projectiles: sball (weak) / fball (strong), tracked from shot events.
  if (body.kind === "projectile") {
    const name = shotKindById.get(body.id) ||
      (Math.abs(body.vy || 0) >= 375 ? "fball" : "sball");
    const size = sprites.size(name);
    sprites.draw(ctx, name, pose.x, pose.y, {
      scale: size.w ? body.size / size.w : 1,
      angle: pose.angle || 0,
      alpha: state.alpha,
      bright: 255,
    });
    return;
  }

  // Special orb: the original special piece is a 24px circle (cir sprites
  // are exactly 24x24) that cycles its colour while it waits.
  if (body.kind === "bonus") {
    const cycle = Math.floor(now / 400) % 5;
    sprites.draw(ctx, `cir0${cycle}`, pose.x, pose.y, {
      scale: 1, angle: pose.angle || 0, alpha: 255, bright: state.bright,
    });
    return;
  }

  const name = blockSpriteName(body, metsu);
  if (!sprites.has(name)) return;   // vector fallback below
  const natural = sprites.size(name);
  const scale = natural.w ? body.size / natural.w : 1;
  sprites.draw(ctx, name, pose.x, pose.y, {
    scale, angle: pose.angle || 0, alpha: state.alpha, bright: state.bright,
  });
  // Anim 2 (grouped or popping): the glow pass — an additive copy of the
  // sprite, matching the original's additive anim layer.
  if (state.anim === 2) {
    sprites.draw(ctx, name, pose.x, pose.y, {
      scale, angle: pose.angle || 0, alpha: 150, bright: 255, additive: true,
    });
  }
}

function drawBody(body, now) {
  const size = Math.max(2, body.size);
  if (assetsReady && sprites.size("box00").w) {
    drawBodySprite(body, body, now);
    return;
  }
  const color = colorFor(body, now);
  if (hasActivatedTrail(body)) {
    const trail = bodyTrails.get(body.id) || [];
    trail.slice(0, -1).forEach((pose, index, echoes) => {
      const alphaOffset = activatedTrailAlphas.length - echoes.length;
      fillBody(body, size, color, pose,
        activatedTrailAlphas[alphaOffset + index]);
    });
  }
  fillBody(body, size, color, body,
    body.lifecycle === "scripted_falling" ? .62 : 1);
  if (body.bubble) {
    // Rising/popped metsu bubbles get a rim so they read as bubbles, and a
    // pulsing glow ring while the pop countdown runs.
    ctx.save();
    ctx.translate(body.x, body.y);
    ctx.globalAlpha = .8;
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#e8fbffcc";
    bodyPath(body, size);
    ctx.stroke();
    if (body.pop_countdown > 0) {
      const pulse = .5 + .5 * Math.sin(now / 90);
      ctx.globalAlpha = .35 + .55 * pulse;
      ctx.lineWidth = 3 + 3 * pulse;
      ctx.strokeStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(0, 0, size / 2 + 4 + 2 * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
  // v2.03 renders rotten pieces with their normal color and shape. The small
  // gray squares in reference footage are projectiles, not dead blocks.
}

function drawBackdrop(state) {
  if (assetsReady) {
    const name = backgroundName(state || {score: 0, level: 1});
    if (sprites.has(name)) {
      sprites.draw(ctx, name, 320, 240, {});
      return;
    }
  }
  ctx.fillStyle = "#0c1517";
  ctx.fillRect(0, 0, 640, 480);
}

function outlinedText(text, x, y, size, align = "left", c = ctx) {
  c.save();
  c.textAlign = align;
  c.font = `italic 900 ${size}px "Trebuchet MS", sans-serif`;
  c.lineJoin = "round";
  c.strokeStyle = "#55152c";
  c.lineWidth = 5;
  c.strokeText(text, x, y);
  c.fillStyle = "#f0e2a6";
  c.fillText(text, x, y);
  c.restore();
}

// The HUD text only changes when the level or score does, so render it once into
// a small offscreen strip and blit it, instead of stroking text every frame.
const HUD_Y = 400;
function makeStrip() {
  const strip = document.createElement("canvas");
  strip.width = 640;
  strip.height = 480 - HUD_Y;
  const c = strip.getContext("2d");
  c.translate(0, -HUD_Y);
  return {canvas: strip, ctx: c, key: null};
}
const levelStrip = makeStrip();
const scoreStrip = makeStrip();
let gaugeGradient = null;
let lifeGradient = null;

function drawLifeGauge(state) {
  // Metsu side: the INI draws a vertical game_life gauge at x=34,y=100 with a
  // white track and a bright blue fill (0x3f3fd9), plus a numeric readout.
  const x = 34, y = 100, w = 20, h = 350;
  ctx.fillStyle = "#ffffff2e";
  ctx.fillRect(x, y, w, h);
  const ratio = Math.max(0, Math.min(1, state.gauge / state.gauge_max));
  if (!lifeGradient) {
    lifeGradient = ctx.createLinearGradient(0, y + h, 0, y);
    lifeGradient.addColorStop(0, "#2a2a96");
    lifeGradient.addColorStop(1, "#6a6aff");
  }
  ctx.fillStyle = lifeGradient;
  ctx.fillRect(x, y + h * (1 - ratio), w, h * ratio);
  ctx.fillStyle = "#ffffff26";
  ctx.fillRect(x, y, 3, h);
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "900 15px Georgia, serif";
  ctx.strokeStyle = "#1b2440";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  const text = String(Math.max(0, state.gauge));
  ctx.strokeText(text, x + w / 2, y - 10);
  ctx.fillStyle = "#cfd8ff";
  ctx.fillText(text, x + w / 2, y - 10);
  ctx.restore();
}

function cachedStrip(strip, key, render) {
  if (strip.key !== key) {
    strip.key = key;
    strip.ctx.clearRect(0, HUD_Y, 640, 480 - HUD_Y);
    render(strip.ctx);
  }
  ctx.drawImage(strip.canvas, 0, HUD_Y);
}

function drawHud(state) {
  cachedStrip(levelStrip, state.level, (c) => {
    outlinedText("Level", 21, 428, 28, "left", c);
    outlinedText(String(state.level), 52, 458, 25, "center", c);
  });

  if (gameMode === "metsu") {
    drawLifeGauge(state);
  } else {
    const trackX = 151, trackY = 437, trackW = 312, trackH = 15;
    ctx.fillStyle = "#33161eaa";
    ctx.fillRect(trackX, trackY, trackW, trackH);
    const ratio = Math.max(0, Math.min(1, state.gauge / state.gauge_max));
    if (!gaugeGradient) {
      gaugeGradient = ctx.createLinearGradient(trackX, 0, trackX + trackW, 0);
      gaugeGradient.addColorStop(0, "#7c1b31");
      gaugeGradient.addColorStop(1, "#b02a3f");
    }
    ctx.fillStyle = gaugeGradient;
    ctx.fillRect(trackX, trackY, trackW * ratio, trackH);
    ctx.fillStyle = "#ffffff18";
    ctx.fillRect(trackX, trackY, trackW, 3);
  }

  const digits = String(state.score).padStart(8, "0");
  const metsuLayout = gameMode === "metsu";
  // In Metsu the score relocates to the left side (beside the vertical life
  // gauge), smaller and left-aligned, matching the original layout. The cache
  // key is namespaced by mode so a mode switch always re-renders the strip.
  cachedStrip(scoreStrip, (metsuLayout ? "m:" : "n:") + digits, (c) => {
    c.textBaseline = "middle";
    if (metsuLayout) {
      c.textAlign = "left";
      c.font = "900 22px Georgia, serif";
      c.strokeStyle = "#2a1640";
      c.lineWidth = 4;
      c.strokeText(digits, 78, 462);
      c.fillStyle = "#eee0a4";
      c.fillText(digits, 78, 462);
    } else {
      c.textAlign = "center";
      c.font = "900 26px Georgia, serif";
      c.strokeStyle = "#681a38";
      c.lineWidth = 5;
      c.strokeText(digits, 320, 462);
      c.fillStyle = "#eee0a4";
      c.fillText(digits, 320, 462);
    }
  });
}

// Score popups use the original ranking_num_ex digit strip (10 cells of
// 27px), rising one pixel per update for 100 updates like the Number class.
const POPUP_DIGIT_W = 27;
const POPUP_DIGIT_H = 33;

function drawPopupDigits(value, x, y, alpha) {
  if (!assetsReady || !sprites.has("ranking_num_ex")) return false;
  const image = sprites.variant("ranking_num_ex", 255);
  if (!image) return false;
  const text = String(value);
  const total = text.length * POPUP_DIGIT_W;
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let i = 0; i < text.length; i++) {
    const digit = text.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) continue;
    ctx.drawImage(image, digit * POPUP_DIGIT_W, 0, POPUP_DIGIT_W, POPUP_DIGIT_H,
      x - total / 2 + i * POPUP_DIGIT_W, y - POPUP_DIGIT_H / 2,
      POPUP_DIGIT_W, POPUP_DIGIT_H);
  }
  ctx.restore();
  return true;
}

function drawScorePopups(now) {
  for (let index = scorePopups.length - 1; index >= 0; index--) {
    const popup = scorePopups[index];
    const progress = Math.min(1, (now - popup.startedAt) / 900);
    if (progress >= 1) {
      scorePopups.splice(index, 1);
      continue;
    }
    const rise = 42 * (1 - (1 - progress) ** 2);
    const alpha = 1 - progress;
    if (drawPopupDigits(popup.value, popup.x, popup.y - rise, alpha)) continue;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "900 26px Georgia, serif";
    ctx.strokeStyle = "#681a38";
    ctx.lineWidth = 5;
    ctx.lineJoin = "round";
    ctx.strokeText(String(popup.value), popup.x, popup.y - rise);
    ctx.fillStyle = "#eee0a4";
    ctx.fillText(String(popup.value), popup.x, popup.y - rise);
    ctx.restore();
  }
}

// Burst effect: the original clones the block sprite into an effect object
// that expands and fades (state 5, kind 6, bright 48). We mirror that with an
// additive sprite ghost plus a few ptcl particles.
const BURST_EFFECT_MS = 340;
const PARTICLE_COUNT = 5;

function drawBurstEffects(now) {
  for (let index = burstEffects.length - 1; index >= 0; index--) {
    const effect = burstEffects[index];
    const progress = (now - effect.startedAt) / BURST_EFFECT_MS;
    if (progress >= 1) {
      burstEffects.splice(index, 1);
      continue;
    }
    if (effect.sprite && sprites.has(effect.sprite)) {
      sprites.draw(ctx, effect.sprite, effect.x, effect.y, {
        scale: effect.scale * (1 + .55 * progress),
        angle: effect.angle, alpha: 255 * (1 - progress),
        bright: 255, additive: true,
      });
    }
    if (sprites.has("ptcl_a")) {
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const angle = effect.angle + i * (Math.PI * 2 / PARTICLE_COUNT) +
          progress * 1.8;
        const distance = effect.size * (.5 + .9 * progress);
        sprites.draw(ctx, "ptcl_a",
          effect.x + Math.cos(angle) * distance,
          effect.y + Math.sin(angle) * distance, {
            scale: .5, angle, alpha: 220 * (1 - progress),
            bright: 255, additive: true,
          });
      }
    }
  }
  for (let index = popEffects.length - 1; index >= 0; index--) {
    const effect = popEffects[index];
    const progress = (now - effect.startedAt) / 260;
    if (progress >= 1) {
      popEffects.splice(index, 1);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = .8 * (1 - progress);
    ctx.lineWidth = 3 * (1 - progress) + 1;
    ctx.strokeStyle = "#eafcff";
    ctx.beginPath();
    ctx.arc(effect.x, effect.y, effect.size / 2 + 14 * progress, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawWalls(state) {
  if (assetsReady && sprites.has("field_l")) {
    const f = state.field;
    const thick = 16;
    const blank = gameMode === "metsu" ? 30 : 40;
    const cy = f.y + f.height / 2;
    // Sprite sizes: field_l/r 20x380, field_t 460x10, field_b 460x60.
    // The walls visually hug the physics fixtures (clone-validated centers).
    sprites.draw(ctx, "field_l", f.x + thick / 2, cy, {});
    sprites.draw(ctx, "field_r", f.x + f.width + thick, cy, {});
    sprites.draw(ctx, "field_t", f.x + f.width / 2 + thick / 2, f.y, {});
    sprites.draw(ctx, "field_b", f.x + f.width / 2 + thick / 2,
      f.y + f.height + blank + 30, {});
    return;
  }
  const f = state.field;
  const thick = 16;
  const blank = gameMode === "metsu" ? 30 : 40;
  ctx.fillStyle = "#f3f3ef";
  ctx.fillRect(f.x, f.y, thick, f.height);
  ctx.fillRect(f.x + f.width + thick / 2, f.y, thick, f.height);
  ctx.fillRect(f.x - thick / 2, f.y + f.height + blank, f.width + thick * 2, thick);
  ctx.fillRect(f.x + thick, 0, f.width, 10);
  ctx.fillStyle = "#cad0cd55";
  ctx.fillRect(f.x, f.y, 3, f.height);
  ctx.fillRect(f.x + f.width + thick / 2, f.y, 3, f.height);
}

let oldBodiesSource = null;
let oldBodiesById = null;

function isSortedById(bodies) {
  for (let i = 1; i < bodies.length; i++) if (bodies[i - 1].id > bodies[i].id) return false;
  return true;
}

function interpolatedBodies(now) {
  const current = snapshot.observation;
  if (!previousObservation || previousObservation.tick === current.tick) return current.bodies;
  const tickGap = current.tick - previousObservation.tick;
  if (tickGap <= 0 || tickGap > 4) return current.bodies;
  const alpha = Math.min(1, (now - snapshotTime) / Math.min(60, Math.max(20, tickGap * 20)));
  if (oldBodiesSource !== previousObservation) {
    oldBodiesSource = previousObservation;
    oldBodiesById = new Map(previousObservation.bodies.map((body) => [body.id, body]));
  }
  const oldBodies = oldBodiesById;
  return current.bodies.map((body) => {
    const old = oldBodies.get(body.id);
    if (!old) return body;
    let angleDelta = (body.angle - old.angle) % (Math.PI * 2);
    if (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
    if (angleDelta < -Math.PI) angleDelta += Math.PI * 2;
    return {
      ...body,
      x: old.x + (body.x - old.x) * alpha,
      y: old.y + (body.y - old.y) * alpha,
      angle: old.angle + angleDelta * alpha,
    };
  });
}

// While the game is paused and nothing is moving, the canvas already shows the
// right picture, so skip repainting it (saves battery and GPU work).
let dirty = true;

function draw(now) {
  if (!dirty && !snapshot?.running && scorePopups.length === 0 &&
      burstEffects.length === 0 && popEffects.length === 0) {
    requestAnimationFrame(draw);
    return;
  }
  dirty = false;
  const state = snapshot?.observation;
  drawBackdrop(state);
  if (snapshot) {
    drawWalls(state);
    const bodies = interpolatedBodies(now);
    (isSortedById(bodies) ? bodies : [...bodies].sort((a, b) => a.id - b.id))
      .forEach((body) => drawBody(body, now));
    drawBurstEffects(now);
    drawScorePopups(now);
    drawHud(state);
  }
  if (aim.visible) {
    if (assetsReady && sprites.has("pointer")) {
      // The original cursor sprite is additive art: black pixels turn
      // invisible, the white arrow glows (DX_BLENDMODE_ADD).
      sprites.draw(ctx, "pointer", aim.x, aim.y, {additive: true});
    } else {
      ctx.save();
      ctx.strokeStyle = "#ece8dd";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(aim.x, aim.y, 9, 0, Math.PI * 2);
      ctx.moveTo(aim.x - 15, aim.y); ctx.lineTo(aim.x - 5, aim.y);
      ctx.moveTo(aim.x + 5, aim.y); ctx.lineTo(aim.x + 15, aim.y);
      ctx.moveTo(aim.x, aim.y - 15); ctx.lineTo(aim.x, aim.y - 5);
      ctx.moveTo(aim.x, aim.y + 5); ctx.lineTo(aim.x, aim.y + 15);
      ctx.stroke();
      ctx.restore();
    }
  }
  requestAnimationFrame(draw);
}

function processEvents(events) {
  frameBurstCount = 0;
  for (const event of events) {
    if (event.sequence <= lastEvent) continue;
    lastEvent = event.sequence;
    switch (event.kind_name) {
      case "shot_fired":
        shotKindById.set(event.a, event.value === 1 ? "fball" : "sball");
        break;
      case "bubble_popped":
        sfx.bubblePop(event.value);
        popEffects.push({
          x: bodyPositions.get(event.a)?.x || 320,
          y: bodyPositions.get(event.a)?.y || 240,
          size: 58, startedAt: performance.now(),
        });
        break;
      case "rotten":
        sfx.rotPenalty();
        break;
      case "projectile_contact":
        sfx.hitTick();
        break;
      case "projectile_hit":
        if (event.value >= 2) sfx.hitCrush();
        else sfx.hitTick();
        break;
      case "level_changed":
        sfx.levelUp();
        showToast(`LEVEL ${event.value}`);
        break;
      case "game_over":
        sfx.gameOver();
        break;
    }
    if (event.kind_name === "score_changed" && event.value > 0) {
      pendingScores.push(event);
    } else if (event.kind_name === "cleared" &&
               event.detail === "normal burst actor teardown") {
      frameBurstCount += 1;
      const index = pendingScores.findIndex(score => score.tick === event.tick);
      const body = bodyPositions.get(event.a);
      if (index >= 0) {
        const [score] = pendingScores.splice(index, 1);
        const position = body || {x: 320, y: 240};
        scorePopups.push({x: position.x, y: position.y,
          value: score.value, startedAt: performance.now()});
      }
      if (body) {
        const metsu = gameMode === "metsu";
        const sprite = blockSpriteName(body, metsu);
        const natural = sprites.size(sprite);
        burstEffects.push({
          x: body.x, y: body.y, sprite,
          scale: natural.w ? body.size / natural.w : 1,
          angle: body.angle || 0, size: body.size,
          startedAt: performance.now(),
        });
      }
    }
  }
  // The burst fanfare plays once per contact frame in the original
  // (after the whole traversal), keyed on the frame's best chain.
  if (frameBurstCount > 0) sfx.burst(frameBurstCount - 1);
}

function showReplayPosition(frame, totalFrames) {
  const seconds = (frame * REPLAY_TICK_MS / 1000).toFixed(1);
  const totalSeconds = (totalFrames * REPLAY_TICK_MS / 1000).toFixed(1);
  ui.replayScrubber.setAttribute("aria-valuetext",
    `frame ${frame} of ${totalFrames}`);
  ui.replayPosition.value = `frame ${frame} / ${totalFrames}`;
  ui.replayPosition.textContent =
    `${frame} / ${totalFrames} · ${seconds}s / ${totalSeconds}s`;
}

// Skip DOM writes whose value has not changed: syncUi runs every simulation tick
// and rewriting identical button text forces needless layout work.
const shown = Object.create(null);
function once(key, value, apply) {
  if (shown[key] === value) return;
  shown[key] = value;
  apply(value);
}

function syncUi() {
  if (!snapshot) return;
  soundtrack.update(snapshot);
  const state = snapshot.observation;
  const replay = snapshot.replay;
  const replayMode = snapshot.mode === "replay";
  started ||= snapshot.running || state.tick > 0;
  once("pauseLabel", snapshot.running ? "pause " : "resume ", (v) => { ui.pause.firstChild.textContent = v; });
  ui.pause.disabled = replayMode && replay.frame >= replay.total_frames;
  ui.paused.hidden = !started || snapshot.running || state.terminated || state.truncated;
  ui.over.hidden = replayMode ?
    !(replay.complete && replay.frame >= replay.total_frames) :
    !(state.terminated || state.truncated);
  if (!ui.over.hidden) {
    ui.finalTitle.textContent = replayMode ?
      snapshot.terminal_reason === "replay_exhausted" ? "Replay exhausted" : "Replay complete" :
      snapshot.terminal_reason === "level_completed" ? "Level 100 complete" :
        snapshot.terminal_reason === "time_limit" ? "Time limit" : "Game over";
    ui.finalScore.textContent = `${String(state.score).padStart(8, "0")} · level ${state.level}`;
  }
  ui.saveReplay.hidden = replayMode || !snapshot.can_save_replay;
  once("againLabel", replayMode ? "new game" : "try again", (v) => { ui.again.textContent = v; });
  ui.replayControls.hidden = !replayMode;
  ui.app.classList.toggle("replay-mode", replayMode);
  once("mode", snapshot.mode, (v) => { document.documentElement.dataset.mode = v; });
  if (replayMode) {
    if (replay.cursor) aim = {x: replay.cursor.x, y: replay.cursor.y, visible: true};
    else aim.visible = false;
    ui.replayName.textContent = replay.name;
    ui.replayScrubber.max = String(replay.total_frames);
    const scrubTarget = replayScrubTarget === null ? null :
      Math.min(replayScrubTarget, replay.total_frames);
    if (scrubTarget === replay.frame) replayScrubTarget = null;
    if (!replayScrubbing && replayScrubTarget === null) {
      ui.replayScrubber.value = String(replay.frame);
      showReplayPosition(replay.frame, replay.total_frames);
    }
    ui.replayPlay.textContent = snapshot.running ? "pause" : "play";
    ui.replaySpeed.value = String(replay.speed);
    ui.replayPlay.disabled = replay.frame >= replay.total_frames;
    ui.replayBack.disabled = replay.frame <= 0;
    ui.replayForward.disabled = replay.frame >= replay.total_frames;
    ui.replayStatus.textContent = replay.buffering ?
      `Buffering ${replay.buffered_frames} / ${replay.total_frames}…` :
      replay.complete ? (replay.warning || "Exact replay ready") :
        `Prepared ${replay.buffered_frames} / ${replay.total_frames}`;
    if (replay.complete) announceReplay("complete", "Replay is ready");
    else if (replay.buffering) announceReplay("buffering", "Buffering replay");
    ui.replayError.textContent = replay.warning;
    ui.replayError.hidden = !replay.warning;
    document.documentElement.dataset.replayFrame = String(replay.frame);
    document.documentElement.dataset.replayBuffered = String(replay.buffered_frames);
  } else {
    replayScrubbing = false;
    replayScrubTarget = null;
    lastReplayAnnouncement = "";
    ui.replayError.hidden = true;
    delete document.documentElement.dataset.replayFrame;
    delete document.documentElement.dataset.replayBuffered;
    processEvents(snapshot.events);
  }
}

// A failed download shows up as "Failed to fetch" (Chrome) or "Load failed" (Safari),
// followed by a stack trace. Say what actually happened and how to fix it.
function isNetworkFailure(error) {
  return /failed to fetch|load failed|networkerror/i.test(error?.message || String(error));
}

function friendlyError(error) {
  if (!isNetworkFailure(error)) return error?.message || String(error);
  return navigator.onLine === false ?
    "The game files are not stored on this device (it may have cleared them). Connect to the internet and they will download again." :
    "The game files could not be downloaded. Check your connection and try again.";
}

function receiveSnapshot(next, error) {
  if (error) {
    const message = friendlyError(error);
    document.documentElement.dataset.ready = "false";
    document.documentElement.dataset.error = error.message;
    ui.replayError.textContent = message;
    ui.replayError.hidden = false;
    showPersistentError(message);
    if (ui.runtimeLoading) ui.runtimeLoading.hidden = true;
    showToast(message, 6000);
    // Retry by itself as soon as the connection is back.
    if (isNetworkFailure(error)) window.addEventListener("online", () => location.reload(), {once: true});
    return;
  }
  acceptSnapshot(next);
  if (ui.runtimeLoading) ui.runtimeLoading.hidden = true;
  document.documentElement.dataset.ready = "true";
  delete document.documentElement.dataset.error;
  document.documentElement.dataset.tick = String(next.observation.tick);
  once("seed", String(next.seed), (v) => { document.documentElement.dataset.seed = v; });
  syncUi();
}

canvas.addEventListener("pointermove", (event) => {
  if (snapshot?.mode === "replay") return;
  aim = {...canvasPoint(event), visible: true};
  dirty = true;
  game?.setAim(aim.x, aim.y);
});
canvas.addEventListener("pointerleave", () => {
  if (snapshot?.mode !== "replay") { aim.visible = false; dirty = true; }
});
canvas.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  canvas.focus({preventScroll: true});
  if (snapshot?.mode === "replay") return;
  aim = {...canvasPoint(event), visible: true};
  dirty = true;
  game?.setAim(aim.x, aim.y);
  shoot(event.shiftKey ? "both" : event.button === 2 ? "strong" :
    event.pointerType === "mouse" ? "weak" : touchShot);
});
for (const button of ui.shotButtons) {
  button.addEventListener("click", () => {
    touchShot = button.dataset.shot;
    for (const other of ui.shotButtons) {
      other.setAttribute("aria-pressed", String(other === button));
    }
  });
}
ui.fastForward.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  ui.fastForward.setPointerCapture?.(event.pointerId);
  if (snapshot?.mode !== "replay") startFastForward();
});
function syncMute() {
  const muted = soundtrack.isMuted();
  sfx.setMuted(muted);
  ui.mute.setAttribute("aria-pressed", String(muted));
  const label = muted ? "Unmute sound" : "Mute sound";
  ui.mute.setAttribute("aria-label", label);
  ui.mute.title = label;
}
ui.mute.addEventListener("click", () => { soundtrack.toggleMute(); syncMute(); });
syncMute();
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  ui.fastForward.addEventListener(type, stopFastForward);
}
ui.fastForward.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (snapshot?.mode === "replay") return;
  if (event.deltaY > 0) continueFastForward();
  else if (event.deltaY < 0) stopFastForward();
}, {passive: false});
ui.pause.addEventListener("click", () => setRunning(!snapshot?.running));
ui.restart.addEventListener("click", () => { void restart(); });
ui.again.addEventListener("click", () => { void restart(); });
ui.saveReplay.addEventListener("click", saveReplay);
ui.openReplay.addEventListener("click", () => {
  if (ui.replayFile.showPicker) ui.replayFile.showPicker();
  else ui.replayFile.click();
});
ui.replayFile.addEventListener("change", () => {
  const file = ui.replayFile.files?.[0];
  ui.replayFile.value = "";
  if (file) void openReplayFile(file);
});
ui.replayPlay.addEventListener("click", () => setRunning(!snapshot?.running));
ui.replayBack.addEventListener("click", () => game?.stepReplay(-replaySkipFrames));
ui.replayForward.addEventListener("click", () => game?.stepReplay(replaySkipFrames));
ui.replaySpeed.addEventListener("change", () => game?.setReplaySpeed(
  Number(ui.replaySpeed.value)));
ui.replayScrubber.addEventListener("input", () => {
  replayScrubbing = true;
  replayScrubTarget = null;
  const frame = Number(ui.replayScrubber.value);
  showReplayPosition(frame, Number(ui.replayScrubber.max));
});
ui.replayScrubber.addEventListener("change", () => {
  const frame = clampReplayScrubFrame(
    ui.replayScrubber.value, snapshot?.replay?.buffered_frames,
  );
  replayScrubbing = false;
  replayScrubTarget = frame;
  ui.replayScrubber.value = String(frame);
  showReplayPosition(frame, Number(ui.replayScrubber.max));
  game?.seekReplay(frame, {preserveRunning: true});
});
ui.exitReplay.addEventListener("click", () => { void restart(); });
window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement ||
      event.target instanceof HTMLSelectElement || event.target?.isContentEditable) return;
  if (snapshot?.mode === "replay" &&
      ["Enter", "ArrowLeft", "ArrowRight"].includes(event.code)) {
    event.preventDefault();
    if (event.repeat && event.code === "Enter") return;
    if (event.code === "Enter") setRunning(!snapshot.running);
    else game?.stepReplay(event.code === "ArrowLeft" ?
      -replaySkipFrames : replaySkipFrames);
    return;
  }
  if (event.code === "Enter") { event.preventDefault(); setRunning(!snapshot?.running); }
  if (event.code === "Space") {
    event.preventDefault();
    if (!event.repeat && snapshot?.mode !== "replay") startFastForward();
  }
  if (event.key.toLowerCase() === "r") void restart();
  if (snapshot?.mode !== "replay" && event.key.toLowerCase() === "w") shoot("weak");
  if (snapshot?.mode !== "replay" && event.key.toLowerCase() === "s") shoot("strong");
});
window.addEventListener("keyup", (event) => {
  if (event.code === "Space") stopFastForward();
});
window.addEventListener("blur", stopFastForward);
// Switching apps should not cost a run or burn battery in the background.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) return;
  stopFastForward();
  if (snapshot?.running) setRunning(false);
});
if (window.matchMedia?.("(pointer: coarse)").matches) {
  // Keep the page fixed: no pull-to-refresh, rubber-banding or pinch zoom.
  document.addEventListener("touchmove", (event) => {
    if (!event.target.closest?.("input, select")) event.preventDefault();
  }, {passive: false});
  for (const type of ["gesturestart", "gesturechange"]) {
    document.addEventListener(type, (event) => event.preventDefault());
  }
}

draw();
syncModeUi();
BrowserGame.create(receiveSnapshot).then((instance) => {
  game = instance;
  game.setAim(aim.x, aim.y);
  document.documentElement.dataset.backend = "exact-v86";
  document.documentElement.dataset.ready = "true";
  ui.openReplay.disabled = false;
  void watchOffline();
})
  .catch((error) => receiveSnapshot(null, error));

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
