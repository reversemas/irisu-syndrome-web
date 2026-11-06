import assert from "node:assert/strict";
import test from "node:test";
import {createSoundtrack, pickNext} from "../static/music.mjs";

const tracks = ["./music/a.mp3", "./music/b.mp3", "./music/c.mp3"];
const running = (seed = 1, extra = {}) => ({seed, mode: "play", running: true, observation: {terminated: false}, ...extra});

function fakeAudio() {
  const listeners = {};
  return {
    src: "", paused: true, plays: 0, pauses: 0,
    addEventListener(name, callback) { listeners[name] = callback; },
    emit(name) { listeners[name]?.(); },
    play() { this.paused = false; this.plays++; return Promise.resolve(); },
    pause() { this.paused = true; this.pauses++; },
  };
}

async function setup(random = () => 0, list = tracks, storage = new Map()) {
  const audio = fakeAudio();
  const localStorage = {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)};
  const music = createSoundtrack({}, {location: {protocol: "capacitor:"}, localStorage, setTimeout}, {
    random, createAudio: () => audio, loadTracks: async () => ({version: "v", tracks: list}), cache: async () => {},
    delayCache: 0,
  });
  await music.ready;
  return {audio, music};
}

test("pickNext never repeats the previous track when there is a choice", () => {
  for (let i = 0; i < 20; i++) assert.notEqual(pickNext(tracks, "./music/b.mp3", () => i / 20), "./music/b.mp3");
  assert.equal(pickNext(["only.mp3"], "only.mp3"), "only.mp3");
  assert.equal(pickNext([], null), null);
  assert.equal(pickNext(tracks, null, () => 0.999999), "./music/c.mp3");
});

test("music waits for a user gesture, then plays a random track", async () => {
  const {audio, music} = await setup(() => 0.5);
  music.update(running());
  assert.equal(audio.plays, 0);
  music.start();
  assert.equal(audio.src, "./music/b.mp3");
  assert.equal(audio.plays, 1);
});

test("when a track ends another random track starts, never the same one", async () => {
  const {audio, music} = await setup(() => 0);
  music.update(running());
  music.start();
  const first = audio.src;
  audio.paused = true;
  audio.emit("ended");
  assert.notEqual(audio.src, first);
  assert.equal(audio.plays, 2);
});

test("pausing or ending the game pauses the music, resuming continues the same track", async () => {
  const {audio, music} = await setup(() => 0);
  music.start();
  music.update(running());
  const track = audio.src;
  music.update(running(1, {running: false}));
  assert.equal(audio.paused, true);
  music.update(running());
  assert.equal(audio.src, track);
  assert.equal(audio.paused, false);
  music.update(running(1, {observation: {terminated: true}}));
  assert.equal(audio.paused, true);
});

test("a new run picks a fresh random track", async () => {
  const {audio, music} = await setup(() => 0);
  music.start();
  music.update(running(1));
  const first = audio.src;
  music.update(running(2));
  assert.notEqual(audio.src, first);
  assert.equal(audio.paused, false);
});

test("an unreadable track is skipped, and it stops after every track failed", async () => {
  const {audio, music} = await setup(() => 0, ["./music/x.mp3", "./music/y.mp3"]);
  music.start();
  music.update(running());
  for (let i = 0; i < 6; i++) audio.emit("error");
  assert.ok(audio.plays <= 3);
});

test("no tracks means silence without errors", async () => {
  const {audio, music} = await setup(() => 0, []);
  music.start();
  music.update(running());
  assert.equal(audio.plays, 0);
});

test("mute pauses immediately, blocks playback and track changes, and unmuting resumes", async () => {
  const {audio, music} = await setup(() => 0);
  music.start();
  music.update(running());
  assert.equal(audio.paused, false);
  assert.equal(music.setMuted(true), true);
  assert.equal(audio.paused, true);
  const plays = audio.plays;
  audio.emit("ended");
  music.update(running(1));
  assert.equal(audio.plays, plays);
  assert.equal(audio.paused, true);
  assert.equal(music.toggleMute(), false);
  assert.equal(audio.paused, false);
});

test("the mute choice is remembered across launches", async () => {
  const storage = new Map();
  const first = await setup(() => 0, tracks, storage);
  first.music.setMuted(true);
  assert.equal(storage.get("irisu:muted"), "1");
  const second = await setup(() => 0, tracks, storage);
  assert.equal(second.music.isMuted(), true);
  second.music.start();
  second.music.update(running());
  assert.equal(second.audio.plays, 0);
  second.music.setMuted(false);
  assert.equal(storage.get("irisu:muted"), "0");
  assert.equal(second.audio.plays, 1);
});

test("unmuting works as the first gesture even before any shot was fired", async () => {
  const storage = new Map([["irisu:muted", "1"]]);
  const {audio, music} = await setup(() => 0, tracks, storage);
  music.update(running());
  assert.equal(audio.plays, 0);
  music.setMuted(false);
  assert.equal(audio.plays, 1);
});

function setupExclusive(random = () => 0) {
  const audios = [];
  const storage = new Map();
  const music = createSoundtrack({}, {location: {protocol: "capacitor:"},
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)}, setTimeout}, {
    random,
    createAudio: () => { const audio = fakeAudio(); audios.push(audio); return audio; },
    loadTracks: async () => ({version: "v", tracks}),
    cache: async () => {},
    delayCache: 0,
  });
  return {audios, music, ready: music.ready};
}

test("an exclusive jingle stops the soundtrack and a passing one hands control back", async () => {
  const {audios, music, ready} = setupExclusive();
  await ready;
  music.start();
  music.update(running());
  const main = audios[0];
  assert.equal(main.plays, 1);
  music.playExclusive("bgm/i_go03B.mp3", {persist: false});
  assert.equal(main.paused, true);
  const jingle = audios[1];
  assert.equal(jingle.src, "bgm/i_go03B.mp3");
  assert.equal(jingle.plays, 1);
  music.update(running());          // must not restart the BGM mid-jingle
  assert.equal(main.plays, 1);
  jingle.emit("ended");             // passing jingle ends -> BGM resumes
  assert.equal(main.paused, false);
  assert.equal(main.plays, 2);
});

test("a persisting jingle keeps the stage silent until a new run", async () => {
  const {audios, music, ready} = setupExclusive();
  await ready;
  music.start();
  music.update(running());
  music.update(running(1, {observation: {terminated: true}}));
  const main = audios[0];
  music.playExclusive("bgm/irisu_gos1.mp3", {persist: true});
  const jingle = audios[1];
  jingle.emit("ended");
  music.update(running(1, {observation: {terminated: true}}));
  assert.equal(main.paused, true);  // the result screen stays silent
  music.update(running(2));         // a new run restarts the soundtrack
  assert.equal(main.paused, false);
  // A run that ends while its jingle is still playing stops that jingle.
  music.playExclusive("bgm/i_go05A.mp3", {persist: true});
  const second = audios[2];
  assert.equal(second.paused, false);
  music.update(running(3));         // new run interrupts the playing jingle
  assert.equal(second.paused, true);
});

test("muting silences a playing jingle without stopping it", async () => {
  const {audios, music, ready} = setupExclusive();
  await ready;
  music.start();
  music.update(running());
  music.playExclusive("bgm/i_go05A.mp3", {persist: true});
  const jingle = audios[1];
  music.setMuted(true);
  assert.equal(jingle.muted, true);
  assert.equal(jingle.paused, false);
  music.setMuted(false);
  assert.equal(jingle.muted, false);
});
