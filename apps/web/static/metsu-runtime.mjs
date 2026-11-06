// Metsu (nonzero-mode) browser runtime: drives the portable irisu-wasm module
// with the same snapshot interface the exact v86 runtime exposes for normal
// mode, so app.js can treat both backends uniformly.
import {
  decodeReplayWord, encodeReplayWord, quantizeReplayPoint, REPLAY_TICK_MS,
  serializeReplay,
} from "./replay.mjs?v=20261106c";

const kinds = {weak: 1, strong: 2, both: 3};
const FAST_FORWARD_STEPS = 4;

async function loadModule() {
  const factory = (await import("./irisu-wasm.js?v=20261106c")).default;
  try {
    return await factory();
  } catch (_) {
    // Fallback for contexts where the default fetch of the adjacent
    // irisu-wasm.wasm is unavailable (for example file:// or test hosts).
    const url = new URL("./irisu-wasm.wasm?v=20261106c", import.meta.url);
    let binary;
    if (typeof process !== "undefined" && process.versions?.node) {
      const {readFile} = await import("node:fs/promises");
      binary = await readFile(url);
    } else {
      binary = new Uint8Array(await (await fetch(url)).arrayBuffer());
    }
    return factory({instantiateWasm: (imports, receive) => {
      WebAssembly.instantiate(binary, imports)
        .then(result => receive(result.instance));
    }});
  }
}

export class MetsuGame {
  static async create(onSnapshot, options = {}) {
    const game = new MetsuGame(onSnapshot, options);
    await game.bootstrap(options.startRunning ?? true);
    return game;
  }

  constructor(onSnapshot, {clock = globalThis, now = () => performance.now(),
    seed} = {}) {
    this.onSnapshot = onSnapshot;
    this.clock = clock;
    this.now = now;
    this.seed = seed === undefined ? crypto.getRandomValues(new Uint32Array(1))[0] : seed >>> 0;
    this.running = false;
    this.fastForward = false;
    this.queue = [];
    this.events = [];
    this.aim = {x: 320, y: 390};
    this.mode = "live";
    this.recordedWords = [];
    this.recordedMetadata = null;
    this.replayData = null;
    this.replayName = "";
    this.replayFrame = 0;
    this.replayComplete = false;
    this.replaySpeed = 1;
    this.terminalReason = null;
    this.timer = 0;
    this.deadline = 0;
    this.processing = false;
    this.closed = false;
    this.lastEmittedTick = -1;
  }

  async bootstrap(running) {
    this.module = await loadModule();
    this.createSim = this.module.cwrap("irisu_web_create_mode", "number",
      ["number", "number"]);
    this.destroySim = this.module.cwrap("irisu_web_destroy", null, ["number"]);
    this.resetCall = this.module.cwrap("irisu_web_reset", "string",
      ["number", "number"]);
    this.stepCall = this.module.cwrap("irisu_web_step_ex", "string",
      ["number", "number", "number", "number", "number", "number"]);
    if (!await this.restart(this.seed, running)) {
      throw this.lastError || new Error("metsu runtime failed to start");
    }
    this.schedule();
  }

  createSimulator(seed) {
    if (this.simulator) this.destroySim(this.simulator);
    this.simulator = this.createSim(seed >>> 0, 1);
    if (!this.simulator) throw new Error("metsu simulator creation failed");
  }

  rawStep(kind, x, y, suppress, waitTicks) {
    const text = this.stepCall(this.simulator, kind, x, y, suppress ? 1 : 0,
      waitTicks);
    if (!text) throw new Error("metsu step failed");
    return JSON.parse(text);
  }

  emit() {
    this.onSnapshot({observation: this.observation, events: this.events,
      running: this.running, fastForward: this.fastForward,
      seed: this.seed, terminal_reason: this.terminalReason,
      mode: this.mode,
      can_save_replay: this.mode === "live" && Boolean(this.recordedMetadata),
      replay: this.mode === "replay" ? this.replayState() : null});
  }

  replayState() {
    return {name: this.replayName, frame: this.replayFrame,
      total_frames: this.replayData.frameCount,
      source_frames: this.replayData.frameCount,
      buffered_frames: this.replayData.frameCount,
      complete: true, buffering: false, warning: "", speed: this.replaySpeed,
      cursor: this.replayFrame > 0 ?
        decodeReplayWord(this.replayData.words[this.replayFrame - 1]) : null};
  }

  acceptStep(state, replayWord = null) {
    this.observation = state.observation;
    this.events.push(...state.events);
    if (this.events.length > 80) this.events.splice(0, this.events.length - 80);
    if (replayWord !== null && this.mode === "replay") {
      this.replayFrame += 1;
    }
    if (this.observation.terminated || this.observation.truncated) {
      this.terminalReason = this.observation.truncated ? "time_limit" : "game_over";
      if (this.mode === "replay") this.terminalReason = "replay_exhausted";
      if (this.mode === "live" && !this.recordedMetadata) {
        this.recordedMetadata = {
          highestLevel: this.observation.level,
          finalScore: this.observation.score,
          highestChain: this.observation.highest_chain,
        };
      }
      this.running = false;
      this.fastForward = false;
      this.queue.length = 0;
    }
    if (this.mode === "replay" && this.replayFrame >= this.replayData.frameCount) {
      this.replayComplete = true;
      this.running = false;
      this.terminalReason = "replay_exhausted";
    }
  }

  async restart(seed, running = true) {
    this.seed = seed >>> 0;
    this.mode = "live";
    this.running = false;
    this.fastForward = false;
    this.queue.length = 0;
    this.events.length = 0;
    this.terminalReason = null;
    this.recordedWords = [];
    this.recordedMetadata = null;
    this.replayData = null;
    this.replayName = "";
    this.replayFrame = 0;
    this.replayComplete = false;
    try {
      this.createSimulator(this.seed);
      const state = JSON.parse(this.resetCall(this.simulator, this.seed));
      this.observation = state.observation;
      this.running = Boolean(running && !this.observation.terminated &&
        !this.observation.truncated);
      this.deadline = this.now() + 20;
      this.emit();
      return true;
    } catch (error) {
      this.lastError = error;
      this.report(error);
      return false;
    }
  }

  shoot(kind, x, y) {
    if (!(kind in kinds)) throw new Error(`unknown shot kind: ${kind}`);
    if (this.mode !== "live") return;
    if (!this.observation || this.observation.terminated || this.observation.truncated) return;
    const point = quantizeReplayPoint(x, y);
    this.aim = point;
    if (this.queue.length < 12) this.queue.push({kind: kinds[kind], ...point});
    if (!this.running) this.deadline = this.now() + 20;
    this.running = true;
    this.emit();
  }

  setAim(x, y) {
    this.aim = quantizeReplayPoint(x, y);
  }

  setRunning(running) {
    if (this.mode === "replay") {
      this.running = Boolean(running && this.replayFrame < this.replayData.frameCount);
      this.deadline = this.now() + REPLAY_TICK_MS / this.replaySpeed;
      this.emit();
      return;
    }
    this.running = Boolean(running && this.observation &&
      !this.observation.terminated && !this.observation.truncated);
    if (!this.running) {
      this.fastForward = false;
    }
    this.deadline = this.now() + 20;
    this.emit();
  }

  setFastForward(active) {
    const next = Boolean(active && this.running && this.observation &&
      !this.observation.terminated && !this.observation.truncated);
    if (next === this.fastForward) return;
    this.fastForward = next;
    if (next) void this.pump();
    this.emit();
  }

  setReplaySpeed(speed) {
    const value = Number(speed);
    if (![1, 2, 4, 8].includes(value)) {
      throw new RangeError("replay speed must be 1x, 2x, 4x, or 8x");
    }
    this.replaySpeed = value;
    if (this.mode === "replay") {
      this.deadline = this.now() + this.replayInterval();
      this.emit();
    }
  }

  replayInterval() {
    return REPLAY_TICK_MS / this.replaySpeed;
  }

  nextAction() {
    let action = {kind: 0, ...this.aim};
    if (this.queue.length) action = this.queue.shift();
    return action;
  }

  liveStep() {
    const action = this.nextAction();
    const recordIndex = this.recordedWords.length;
    const state = this.rawStep(action.kind, action.x, action.y, recordIndex < 2, 1);
    const replayWord = encodeReplayWord(action.kind, action.x, action.y);
    this.recordedWords.push(replayWord);
    this.acceptStep(state);
  }

  replayStep() {
    const words = this.replayData.words;
    if (this.replayFrame >= words.length) return false;
    const cursor = decodeReplayWord(words[this.replayFrame]);
    const kind = (cursor.left ? 1 : 0) | (cursor.right ? 2 : 0);
    const state = this.rawStep(kind, cursor.x, cursor.y, this.replayFrame < 2, 1);
    this.acceptStep(state, words[this.replayFrame]);
    return true;
  }

  async pump() {
    if (this.processing || this.closed) return;
    this.processing = true;
    try {
      if (this.mode === "replay") {
        const budget = this.fastForward ? FAST_FORWARD_STEPS : this.replaySpeed;
        for (let index = 0; index < budget &&
             this.running && this.replayFrame < this.replayData.frameCount; ++index) {
          this.replayStep();
        }
        this.deadline = this.now() + this.replayInterval();
      } else {
        const budget = this.fastForward ? FAST_FORWARD_STEPS : 1;
        for (let index = 0; index < budget && this.running; ++index) {
          this.liveStep();
        }
        this.deadline = this.now() + 20;
      }
      this.emit();
    } catch (error) {
      if (!this.closed) this.report(error);
    } finally {
      this.processing = false;
    }
  }

  schedule() {
    const loop = () => {
      if (this.closed) return;
      if (this.running && this.now() >= this.deadline) void this.pump();
      this.timer = this.clock.setTimeout(loop, 4);
    };
    this.timer = this.clock.setTimeout(loop, 4);
  }

  report(error) {
    this.lastError = error;
    this.onSnapshot(null, error);
  }

  replayBytes() {
    if (this.mode !== "live" || !this.recordedMetadata) {
      throw new Error("a replay is available only after a recorded game finishes");
    }
    return serializeReplay({
      seed: this.seed,
      ...this.recordedMetadata,
      words: Uint32Array.from(this.recordedWords),
      mode: 1,
    });
  }

  async loadReplay(replay, name = "replay.rpy") {
    if (replay.mode !== 1) {
      throw new Error("this replay is normal mode; switch to NORMAL before loading it");
    }
    this.mode = "replay";
    this.running = false;
    this.fastForward = false;
    this.queue.length = 0;
    this.events.length = 0;
    this.terminalReason = null;
    this.replayData = replay;
    this.replayName = name;
    this.replayFrame = 0;
    this.replayComplete = false;
    this.seed = replay.seed >>> 0;
    this.createSimulator(this.seed);
    const state = JSON.parse(this.resetCall(this.simulator, this.seed));
    this.observation = state.observation;
    this.emit();
    return true;
  }

  stepReplay(delta) {
    if (this.mode !== "replay") return;
    const target = Math.max(0, Math.min(this.replayData.frameCount,
      this.replayFrame + delta));
    this.seekReplay(target, {preserveRunning: this.running});
  }

  seekReplay(frame, {preserveRunning = false} = {}) {
    if (this.mode !== "replay") return;
    const target = Math.max(0, Math.min(this.replayData.frameCount,
      Math.floor(frame)));
    this.createSimulator(this.seed);
    const state = JSON.parse(this.resetCall(this.simulator, this.seed));
    this.observation = state.observation;
    this.events.length = 0;
    this.replayFrame = 0;
    this.replayComplete = false;
    this.terminalReason = null;
    while (this.replayFrame < target) this.replayStep();
    this.running = Boolean(preserveRunning && this.replayFrame < this.replayData.frameCount);
    this.deadline = this.now() + this.replayInterval();
    this.emit();
  }

  close() {
    this.closed = true;
    this.clock.clearTimeout?.(this.timer);
    if (this.simulator) {
      try { this.destroySim(this.simulator); } catch (_) { /* already gone */ }
      this.simulator = 0;
    }
  }
}
