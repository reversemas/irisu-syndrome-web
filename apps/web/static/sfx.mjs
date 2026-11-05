// Sound engine for the Irisu port — plays the original snd.dxa WAVs at the
// exact events irisu.exe fires them, including the chain-pitched pops
// (SetFrequencySoundMem(17050 + 5000 * min(chain, 8)), reversed at 0x40359f
// and 0x40acc5).

const BUBBLE_PITCH_BASE = 17050;
const BUBBLE_PITCH_STEP = 5000;
const MAX_PITCH_CHAIN = 8;

// Reversed event -> sound map (see reference/phase1-recon addendum):
//   rot penalty          -> buble02   (Block.update 0x40353a)
//   bubble pop           -> buble03 @ chain pitch (0x40359f)
//   burst, chain 0       -> se_c0 = cursor3.wav   (contact fanfare 0x40ac5f)
//   burst, chain >= 1    -> se_c1 = puu89.wav @ chain pitch (0x40accf)
//   burst layer          -> se_v0 = decide10.wav  (0x40ad22)
//   big-chain layer      -> se_v1 = decide12.wav  (0x40ad9c)
//   direct hit tick      -> call07   (0x40a92f)
//   direct hit crush     -> decide3  (0x40a90d)
//   level up             -> power14  (0x40afb9, right after set_level)
//   game over stinger    -> decide10 (finish path 0x40ad49)

export function createSfx({volume = 0.8} = {}) {
  let ctx = null;
  let master = null;
  let muted = false;
  const buffers = new Map();
  const loading = new Map();

  function ensureContext() {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  async function preload(names, onProgress = null) {
    const audio = ensureContext();
    let done = 0;
    await Promise.all(names.map(async name => {
      if (buffers.has(name) || loading.has(name)) {
        done += 1;
        onProgress?.(done, names.length);
        return;
      }
      const promise = fetch(`assets/snd/${name}.wav`)
        .then(r => r.arrayBuffer())
        .then(b => audio.decodeAudioData(b))
        .then(buf => { buffers.set(name, buf); })
        .catch(() => { /* missing sound stays silent */ })
        .finally(() => {
          loading.delete(name);
          done += 1;
          onProgress?.(done, names.length);
        });
      loading.set(name, promise);
    }));
  }

  function play(name, {rate = 1, gain = 1} = {}) {
    if (muted) return;
    const buffer = buffers.get(name);
    if (!buffer) return;
    const audio = ensureContext();
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    if (gain !== 1) {
      const node = audio.createGain();
      node.gain.value = gain;
      source.connect(node).connect(master);
    } else {
      source.connect(master);
    }
    source.start();
  }

  function chainRate(chain) {
    const clamped = Math.max(0, Math.min(MAX_PITCH_CHAIN, chain | 0));
    const frequency = BUBBLE_PITCH_BASE + BUBBLE_PITCH_STEP * clamped;
    const natural = buffers.get("buble03")?.sampleRate
      || buffers.get("puu89")?.sampleRate || 44100;
    return Math.max(0.25, frequency / natural);
  }

  const api = {
    preload,
    unlock: ensureContext,
    setMuted(value) {
      muted = Boolean(value);
      if (master) master.gain.value = muted ? 0 : volume;
    },
    setVolume(value) {
      volume = Math.max(0, Math.min(1, value));
      if (master && !muted) master.gain.value = volume;
    },

    // --- gameplay events -------------------------------------------------
    bubblePop(chain) {
      play("buble03", {rate: chainRate(chain)});
    },
    rotPenalty() {
      play("buble02");
    },
    burst(chain) {
      if (chain <= 0) {
        play("cursor3");
      } else {
        play("puu89", {rate: chainRate(chain)});
      }
      play("decide10", {gain: .8});
      if (chain >= 3) play("decide12", {gain: .7});
    },
    hitTick() {
      play("call07", {gain: .7});
    },
    hitCrush() {
      play("decide3");
    },
    levelUp() {
      play("power14");
    },
    gameOver() {
      play("decide10");
    },
    menuMove() {
      play("cursor3", {gain: .6});
    },
    menuDecide() {
      play("decide2", {gain: .7});
    },
  };
  return api;
}
