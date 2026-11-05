"use strict";

// Offline support. make-precache.mjs stamps {version, files} into BUILD below at
// build time. That changes this file's bytes whenever the app changes, so the
// browser installs a fresh worker per deploy, which downloads the whole new app
// into its own cache in the background and only takes over once the old version
// is no longer in use. Everything is then served cache-first: a weak or hanging
// connection can never block the app from starting.
//
// The big emulator files (wasm, kernel, guest) are stored by exact-worker.js in
// its own versioned cache; music is stored by music.mjs. This worker only
// serves them from there, so nothing is downloaded twice.
const BUILD = /*__BUILD__*/ null;
const SHELL_PREFIX = "irisu-shell-";
const SHELL_CACHE = BUILD ? SHELL_PREFIX + BUILD.version : null;
const MATCH = {ignoreSearch: true, ignoreVary: true};

self.addEventListener("install", (event) => {
  if (!BUILD) return;
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(BUILD.files.map(file => new Request(file, {cache: "reload"})));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    if (SHELL_CACHE) {
      // Only ever delete older shells, and only once this one is known to exist.
      const names = await caches.keys();
      if (names.includes(SHELL_CACHE)) {
        await Promise.all(names
          .filter(name => name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE)
          .map(name => caches.delete(name)));
      }
    }
    await self.clients.claim();
  })());
});

// Safari requests audio with Range headers and rejects a plain 200 from a
// service worker, so answer ranges ourselves from the cached full file.
async function rangeResponse(request, cached) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
  if (!match) return cached;
  const blob = await cached.blob();
  const total = blob.size;
  const start = match[1] === "" ? Math.max(0, total - Number(match[2])) : Number(match[1]);
  const end = match[1] === "" || match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1);
  if (start >= total || start > end) {
    return new Response(null, {status: 416, headers: {"Content-Range": `bytes */${total}`}});
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": cached.headers.get("Content-Type") || "audio/mpeg",
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
    },
  });
}

async function musicResponse(request) {
  const cached = await caches.match(request.url, MATCH);
  if (!cached) return fetch(request);
  return request.headers.has("range") ? rangeResponse(request, cached) : cached;
}

async function runtimeResponse(request) {
  // exact-worker.js stores these under their exact versioned URL.
  const cached = await caches.match(request, {ignoreVary: true});
  return cached || fetch(request);
}

async function shellResponse(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, MATCH);
  if (cached) return cached;
  if (request.mode === "navigate") {
    const shell = await cache.match("./index.html", MATCH);
    if (shell) return shell;
  }
  return fetch(request);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || !BUILD) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.endsWith("/sw.js")) return;
  if (url.pathname.includes("/music/")) {
    event.respondWith(musicResponse(request));
  } else if (url.pathname.includes("/exact-runtime/") && !url.pathname.endsWith("/libv86.js")) {
    event.respondWith(runtimeResponse(request));
  } else {
    event.respondWith(shellResponse(request));
  }
});
