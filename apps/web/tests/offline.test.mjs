import assert from "node:assert/strict";
import test from "node:test";
import {offlineStatus} from "../static/offline.mjs";

function fakeWindow(contents) {
  return {caches: {
    keys: async () => Object.keys(contents),
    open: async (name) => ({keys: async () => new Array(contents[name]).fill(0)}),
  }};
}

test("ready only when shell, runtime and every music track are stored", async () => {
  const full = {"irisu-shell-a": 17, "irisu-exact-runtime-x": 7, "irisu-music-m": 8};
  assert.equal((await offlineStatus(fakeWindow(full), 8)).ready, true);
  assert.equal((await offlineStatus(fakeWindow({...full, "irisu-music-m": 7}), 8)).ready, false);
  assert.equal((await offlineStatus(fakeWindow({...full, "irisu-exact-runtime-x": 6}), 8)).ready, false);
  assert.equal((await offlineStatus(fakeWindow({"irisu-exact-runtime-x": 7, "irisu-music-m": 8}), 8)).ready, false);
});

test("no music files means music is not required; no CacheStorage means unsupported", async () => {
  assert.equal((await offlineStatus(fakeWindow({"irisu-shell-a": 5, "irisu-exact-runtime-x": 7}), 0)).ready, true);
  assert.deepEqual(await offlineStatus({}, 3), {supported: false, ready: false, shell: 0, runtime: 0, music: 0});
});

test("stale caches of older versions do not hide a complete current one", async () => {
  const stale = {"irisu-shell-old": 1, "irisu-shell-new": 17, "irisu-exact-runtime-x": 7, "irisu-music-m": 8};
  assert.equal((await offlineStatus(fakeWindow(stale), 8)).shell, 17);
});
