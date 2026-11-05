#!/usr/bin/env node
// Post-build step for a site dir:
//  - music.json: list of audio files in music/ (loaded by music.mjs)
//  - sw.js: stamped with the app-shell file list + content-hash version
// Music is deliberately not in the shell precache; the page downloads it in the
// background so a large soundtrack can never block service-worker install.
import {createHash} from "node:crypto";
import {existsSync, readdirSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {join, relative} from "node:path";

const dir = process.argv[2];
if (!dir) { console.error("usage: make-precache.mjs SITE_DIR"); process.exit(1); }

const AUDIO = /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i;
const musicDir = join(dir, "music");
const tracks = existsSync(musicDir)
  ? readdirSync(musicDir).filter(name => AUDIO.test(name) && statSync(join(musicDir, name)).isFile()).sort()
  : [];
const musicHash = createHash("sha256");
for (const name of tracks) musicHash.update(name).update(String(statSync(join(musicDir, name)).size));
writeFileSync(join(dir, "music.json"), JSON.stringify({
  version: musicHash.digest("hex").slice(0, 16),
  tracks: tracks.map(name => `./music/${encodeURIComponent(name)}`),
}, null, 2) + "\n");
console.log(`music.json: ${tracks.length} track(s)`);

const files = [];
(function walk(current) {
  for (const name of readdirSync(current).sort()) {
    const path = join(current, name);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    const rel = relative(dir, path).split("\\").join("/");
    if (rel === "sw.js" || rel === "CNAME" || rel.startsWith(".")) continue;
    if (rel.startsWith("music/")) continue;
    if (rel.startsWith("exact-runtime/") && rel !== "exact-runtime/libv86.js") continue;
    files.push(rel);
  }
})(dir);

const hash = createHash("sha256");
for (const file of files) hash.update(file).update(readFileSync(join(dir, file)));
const version = hash.digest("hex").slice(0, 16);

// Stamp the build into the service worker (see sw.js).
const swPath = join(dir, "sw.js");
const swSource = readFileSync(swPath, "utf8");
const marker = "/*__BUILD__*/ null";
if (!swSource.includes(marker)) { console.error("sw.js is missing its build marker"); process.exit(1); }
const build = {version, files: ["./", ...files.map(file => `./${file}`)]};
writeFileSync(swPath, swSource.replace(marker, JSON.stringify(build)));
console.log(`sw.js stamped: ${build.files.length} precached files, version ${version}`);
