// Sprite engine for the Irisu port — loads the original game's PNG assets
// and draws them the way irisu.exe's draw queue does: rotated, alpha'd, and
// brightness-filtered through pre-baked variants (SetDrawBright equivalent).

const BRIGHT_LEVELS = new Set([128, 164, 196, 200, 255]);

// The original loads the 24-bit normal-mode sprites through DxLib with
// SetTransColor(0,0,0): exact black is the transparency key. The triangle and
// circle sheets carry their outside-the-shape padding in black, and the metsu
// ex_ family ships real alpha instead — without the key the padding paints
// black halves over the background doodles. The triangle sheets shade their
// padding into a very dark tint of the block color, so they key on a
// brightness threshold instead of the exact color.
const BLACK_KEYED = /^(?:box|tri|cir)\d\d$|^ex_(?:box|tri|cir)\d\d_\d\d$|^[sf]ball$/;
const THRESHOLD_KEYED = /^tri\d\d$/;

function keyBlackPixels(image, threshold = 0) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const c = canvas.getContext("2d");
  c.drawImage(image, 0, 0);
  const data = c.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const bright = Math.max(px[i], px[i + 1], px[i + 2]);
    if (bright <= threshold) px[i + 3] = 0;
  }
  c.putImageData(data, 0, 0);
  return canvas;
}

export class SpriteBank {
  constructor(base = "assets") {
    this.base = base;
    this.images = new Map();        // name -> HTMLImageElement
    this.sizes = new Map();         // name -> {w, h}
    this.baked = new Map();         // "name@bright" -> canvas
    this.ready = null;
  }

  async load(onProgress = null) {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const manifest = await fetch(`${this.base}/manifest.json`).then(r => r.json());
      const names = Object.keys(manifest.img);
      let done = 0;
      await Promise.all(names.map(name => new Promise(resolve => {
        const image = new Image();
        image.onload = () => {
          this.images.set(name, BLACK_KEYED.test(name) ?
            keyBlackPixels(image, THRESHOLD_KEYED.test(name) ? 100 : 0) : image);
          this.sizes.set(name, {w: image.naturalWidth, h: image.naturalHeight});
          done += 1;
          onProgress?.(done, names.length);
          resolve();
        };
        image.onerror = () => {
          done += 1;
          onProgress?.(done, names.length);
          resolve();
        };
        image.src = `${this.base}/img/${name}.png`;
      })));
      return this;
    })();
    return this.ready;
  }

  has(name) { return this.images.has(name); }
  size(name) { return this.sizes.get(name) || {w: 0, h: 0}; }

  // Pre-baked brightness variant (multiply against gray). 255 returns the
  // raw image. Levels outside the reversed set are baked on demand.
  variant(name, bright) {
    const level = BRIGHT_LEVELS.has(bright) ? bright : Math.round(bright);
    if (level >= 255) return this.images.get(name);
    const key = `${name}@${level}`;
    let canvas = this.baked.get(key);
    if (!canvas) {
      const image = this.images.get(name);
      if (!image) return null;
      canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const c = canvas.getContext("2d");
      c.drawImage(image, 0, 0);
      c.globalCompositeOperation = "multiply";
      c.fillStyle = `rgb(${level},${level},${level})`;
      c.fillRect(0, 0, canvas.width, canvas.height);
      // multiply kills nothing alpha-wise, but restore normal compositing so
      // the canvas keeps the sprite's transparency for "lighter" passes.
      c.globalCompositeOperation = "destination-in";
      c.drawImage(image, 0, 0);
      c.globalCompositeOperation = "source-over";
      this.baked.set(key, canvas);
    }
    return canvas;
  }

  // Draw like the original draw queue's rota record:
  // DrawRotaGraph(x, y, scale, angle, handle, reverse) under
  // SetDrawBright + SetDrawBlendMode(alpha|add).
  draw(ctx, name, x, y, options = {}) {
    const {
      scale = 1, angle = 0, alpha = 255, bright = 255,
      additive = false, reverse = false,
    } = options;
    const source = this.variant(name, bright);
    if (!source) return;
    const {w, h} = this.size(name);
    if (!w || !h) return;
    ctx.save();
    ctx.translate(x, y);
    if (angle) ctx.rotate(angle);
    if (reverse) ctx.scale(-1, 1);
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha / 255));
    if (additive) ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(source, -w * scale / 2, -h * scale / 2, w * scale, h * scale);
    ctx.restore();
  }
}

// Sprite name for a gameplay body, per the reversed loader (0x403dfc):
//   normal mode: "%s%02d"  % (shape, color)
//   metsu mode:  "ex_%s%02d_%02d" % (shape, color, size slot)
const EX_CIRCLE_SLOTS = [42, 58, 74, 90, 104, 120];
const EX_BOX_SLOTS = [30, 48, 64];

export function blockSpriteName(body, metsu) {
  const shape = body.shape === "circle" ? "cir"
    : body.shape === "triangle" ? "tri" : "box";
  const color = Math.max(0, Math.min(9, body.color));
  if (!metsu) return `${shape}${String(color).padStart(2, "0")}`;
  const slots = body.shape === "circle" ? EX_CIRCLE_SLOTS : EX_BOX_SLOTS;
  let slot = 0;
  let best = Infinity;
  for (let i = 0; i < slots.length; i++) {
    const d = Math.abs(slots[i] - body.size);
    if (d < best) { best = d; slot = i; }
  }
  const frame = body.shape === "circle" ? Math.min(slot, 5) : Math.min(slot, 2);
  return `ex_${shape}${String(color).padStart(2, "0")}_${String(frame).padStart(2, "0")}`;
}

// Reversed anim/bright/alpha table from Block's tail update (0x403858):
//   rotten (c8==3)  -> anim 0, alpha 164
//   special (c5)    -> anim 1, bright 200
//   scripted (c4==0)-> anim 1, bright 164 (normal) / 196 (metsu)
//   grouped/popping -> anim 2, bright 128   [physics blocks only]
//   otherwise       -> anim 0, bright 255 (fresh) / anim 1, bright 128 (settled e5)
export function blockRenderState(body, metsu) {
  if (body.lifecycle === "rotten") {
    return {anim: 0, bright: 255, alpha: 164};
  }
  if (body.kind === "bonus") {
    return {anim: 1, bright: 200, alpha: 255};
  }
  if (body.lifecycle === "scripted_falling") {
    return {anim: 1, bright: metsu ? 196 : 164, alpha: 255};
  }
  const grouped = body.lifecycle === "confirmed" || (body.chain_id || 0) !== 0;
  const popping = (body.pop_countdown || 0) > 0;
  if (grouped || popping) {
    return {anim: 2, bright: 128, alpha: 255};
  }
  if (body.lifecycle === "dynamic_fresh") {
    return {anim: 0, bright: 255, alpha: 255};
  }
  return {anim: 1, bright: 128, alpha: 255};
}
