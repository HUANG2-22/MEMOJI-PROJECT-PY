// sketch.js (FINAL)
// Emoji Mosaic (browser-only) using emojis_16.npy
// - Output fixed: 900x900
// - Supports NPY dtype: uint8 (u1) OR float32 (<f4)
// - Pipeline: load npy -> convert to Uint8 RGBA -> compute mean colors -> build spritesheet -> match pixels -> draw mosaic

// =====================
// Config
// =====================
const TARGET_SIZE = 900;
const UI_HEIGHT = 200;

// mosaic resolution: larger => more detail but slower
const MOSAIC_DIM = 75;      // 75x75 -> cell size = 12px

// emojis_16.npy is usually 16x16 RGBA
const EMOJI_SIZE = 16;

// spritesheet layout
const SHEET_COLS = 64;

// mean-color computation
const IGNORE_TRANSPARENT = true;
const ALPHA_CUTOFF = 10;

// IMPORTANT: if emojis_16.npy is in /assets, change to "assets/emojis_16.npy"
const NPY_PATH = "emojis_16.npy";

// =====================
// Globals
// =====================
let uploadedImg = null;
let processedCanvas = null;

let fileInputEl, saveButtonEl;

let npyBytesObj = null;

let emojiCount = 0;
let emojiU8 = null;         // Uint8Array RGBA, length = N*16*16*4
let emojiMeans = null;      // Float32Array length = N*3 (mean RGB)
let emojiSheetImg = null;   // p5.Image spritesheet

let isReady = false;
let statusMsg = "Loading emoji library...";

// =====================
// Preload
// =====================
function preload() {
  npyBytesObj = loadBytes(
    NPY_PATH,
    () => {},
    () => {
      statusMsg = `Failed to load ${NPY_PATH}. Check path / GitHub Pages deployment.`;
    }
  );
}

// =====================
// Setup
// =====================
function setup() {
  createCanvas(TARGET_SIZE, TARGET_SIZE + UI_HEIGHT);
  background(255);

  fileInputEl = createInput("", "file");
  fileInputEl.attribute("accept", "image/*");
  fileInputEl.elt.onchange = handleFileChange;
  fileInputEl.elt.disabled = true; // enable after emoji library is ready

  saveButtonEl = createButton("点击保存处理后的图片");
  saveButtonEl.mousePressed(saveImage);

  textAlign(CENTER, CENTER);
  layoutUI();

  tryInitEmojiLibrary();
}

function layoutUI() {
  fileInputEl.position(width / 2 - 170, 40);
  fileInputEl.style("width", "200px");
  saveButtonEl.position(width / 2 + 60, 40);
}

// =====================
// Upload
// =====================
function handleFileChange(event) {
  if (!isReady) {
    alert("Emoji library not ready yet. Please wait.");
    return;
  }

  const file = event.target.files[0];
  if (!file || !file.type.startsWith("image/")) {
    uploadedImg = null;
    console.error("文件类型错误，请上传图片文件");
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    loadImage(
      e.target.result,
      (img) => {
        uploadedImg = img;
        processImage();
      },
      () => {
        uploadedImg = null;
        console.error("图片加载失败");
      }
    );
  };
  reader.readAsDataURL(file);
}

// =====================
// NPY Parser (minimal)
// Supports v1/v2/v3 headers; dtypes: u1, f4
// =====================
function parseNPY(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);

  // magic: \x93NUMPY
  if (u8[0] !== 0x93 || String.fromCharCode(...u8.slice(1, 6)) !== "NUMPY") {
    throw new Error("Invalid NPY file (bad magic).");
  }

  const major = u8[6];
  const minor = u8[7];

  let headerLen = 0;
  let offset = 0;

  if (major === 1) {
    headerLen = u8[8] | (u8[9] << 8);
    offset = 10;
  } else if (major === 2 || major === 3) {
    headerLen = (u8[8] | (u8[9] << 8) | (u8[10] << 16) | (u8[11] << 24)) >>> 0;
    offset = 12;
  } else {
    throw new Error(`Unsupported NPY version: ${major}.${minor}`);
  }

  const headerBytes = u8.slice(offset, offset + headerLen);
  const headerText = new TextDecoder("ascii").decode(headerBytes);

  // descr
  const descrMatch = headerText.match(/'descr'\s*:\s*'([^']+)'/);
  if (!descrMatch) throw new Error("NPY header missing descr.");
  const descr = descrMatch[1]; // examples: "<u1", "|u1", "<f4"

  // fortran_order
  const fortMatch = headerText.match(/'fortran_order'\s*:\s*(True|False)/);
  if (!fortMatch) throw new Error("NPY header missing fortran_order.");
  const fortranOrder = fortMatch[1] === "True";
  if (fortranOrder) throw new Error("Fortran-order arrays not supported.");

  // shape
  const shapeMatch = headerText.match(/'shape'\s*:\s*\(([^)]*)\)/);
  if (!shapeMatch) throw new Error("NPY header missing shape.");
  const shapeStr = shapeMatch[1].trim();
  const shape = shapeStr
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => parseInt(s, 10));

  const dataOffset = offset + headerLen;

  return { descr, shape, dataOffset };
}

function product(arr) {
  return arr.reduce((a, b) => a * b, 1);
}

function tryInitEmojiLibrary() {
  try {
    if (!npyBytesObj || !npyBytesObj.bytes) {
      statusMsg = "Loading emoji library...";
      return;
    }

    // p5 loadBytes -> Uint8Array, get exact ArrayBuffer slice
    const bytes = npyBytesObj.bytes;
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    statusMsg = "Parsing emojis_16.npy...";
    const parsed = parseNPY(ab);

    // Validate shape (N,16,16,4)
    const shape = parsed.shape;
    if (shape.length !== 4 || shape[1] !== EMOJI_SIZE || shape[2] !== EMOJI_SIZE || shape[3] !== 4) {
      throw new Error(`Unexpected shape: (${shape.join(",")}). Expected (N,16,16,4).`);
    }

    emojiCount = shape[0];
    const totalElems = product(shape); // N*16*16*4

    // Extract raw data buffer (copy to align)
    const dataBuf = ab.slice(parsed.dataOffset);

    // Convert to Uint8 RGBA regardless of input dtype
    statusMsg = `Decoding dtype ${parsed.descr}...`;

    if (parsed.descr.endsWith("u1") || parsed.descr.endsWith("U1")) {
      // uint8
      const u = new Uint8Array(dataBuf);
      if (u.length < totalElems) {
        throw new Error(`Data too short: got ${u.length}, expected ${totalElems}.`);
      }
      emojiU8 = u.slice(0, totalElems);
    } else if (parsed.descr.endsWith("f4") || parsed.descr.endsWith("F4")) {
      // float32
      const f = new Float32Array(dataBuf);
      if (f.length < totalElems) {
        throw new Error(`Data too short: got ${f.length}, expected ${totalElems}.`);
      }
      emojiU8 = float32ToU8RGBA(f, totalElems);
    } else {
      throw new Error(`Unsupported dtype: ${parsed.descr}. Expected uint8 (u1) or float32 (f4).`);
    }

    statusMsg = `Computing mean colors for ${emojiCount} emojis...`;
    emojiMeans = computeEmojiMeans(emojiU8, emojiCount);

    statusMsg = "Building emoji spritesheet...";
    emojiSheetImg = buildEmojiSheetImage(emojiU8, emojiCount);

    isReady = true;
    statusMsg = `Ready. Emoji count: ${emojiCount}. Upload an image.`;
    fileInputEl.elt.disabled = false;
  } catch (e) {
    console.error(e);
    statusMsg = `Emoji init error: ${e.message}`;
    isReady = false;
    fileInputEl.elt.disabled = true;
  }
}

// If float32 values are in [0,1], scale by 255; if already ~[0,255], keep.
// Then clamp to [0,255] and round.
function float32ToU8RGBA(f32, totalElems) {
  // quick detect scale using a small sample
  let maxV = 0;
  const sampleN = Math.min(5000, totalElems);
  for (let i = 0; i < sampleN; i++) {
    const v = f32[i];
    if (v > maxV) maxV = v;
  }
  const use01 = maxV <= 1.5; // likely 0..1 floats
  const out = new Uint8Array(totalElems);

  for (let i = 0; i < totalElems; i++) {
    let v = f32[i];
    if (use01) v = v * 255.0;

    // clamp
    if (v < 0) v = 0;
    if (v > 255) v = 255;

    out[i] = v + 0.5; // round
  }
  return out;
}

function computeEmojiMeans(dataU8, count) {
  // Float32Array: [r0,g0,b0, r1,g1,b1, ...]
  const means = new Float32Array(count * 3);

  const pixelsPerEmoji = EMOJI_SIZE * EMOJI_SIZE;
  const stride = pixelsPerEmoji * 4;

  for (let i = 0; i < count; i++) {
    let rSum = 0, gSum = 0, bSum = 0, c = 0;
    const base = i * stride;

    for (let p = 0; p < pixelsPerEmoji; p++) {
      const idx = base + p * 4;
      const r = dataU8[idx];
      const g = dataU8[idx + 1];
      const b = dataU8[idx + 2];
      const a = dataU8[idx + 3];

      if (IGNORE_TRANSPARENT && a <= ALPHA_CUTOFF) continue;

      rSum += r;
      gSum += g;
      bSum += b;
      c++;
    }

    const out = i * 3;
    if (c === 0) {
      means[out] = 0;
      means[out + 1] = 0;
      means[out + 2] = 0;
    } else {
      means[out] = rSum / c;
      means[out + 1] = gSum / c;
      means[out + 2] = bSum / c;
    }
  }

  return means;
}

function buildEmojiSheetImage(dataU8, count) {
  const rows = Math.ceil(count / SHEET_COLS);
  const sheetW = SHEET_COLS * EMOJI_SIZE;
  const sheetH = rows * EMOJI_SIZE;

  const sheet = createImage(sheetW, sheetH);
  sheet.loadPixels();

  const pixelsPerEmoji = EMOJI_SIZE * EMOJI_SIZE;
  const stride = pixelsPerEmoji * 4;

  for (let i = 0; i < count; i++) {
    const col = i % SHEET_COLS;
    const row = Math.floor(i / SHEET_COLS);

    const dstX0 = col * EMOJI_SIZE;
    const dstY0 = row * EMOJI_SIZE;

    const srcBase = i * stride;

    for (let y = 0; y < EMOJI_SIZE; y++) {
      for (let x = 0; x < EMOJI_SIZE; x++) {
        const srcIdx = srcBase + ((x + y * EMOJI_SIZE) * 4);

        const dx = dstX0 + x;
        const dy = dstY0 + y;
        const dstIdx = (dx + dy * sheetW) * 4;

        sheet.pixels[dstIdx]     = dataU8[srcIdx];
        sheet.pixels[dstIdx + 1] = dataU8[srcIdx + 1];
        sheet.pixels[dstIdx + 2] = dataU8[srcIdx + 2];
        sheet.pixels[dstIdx + 3] = dataU8[srcIdx + 3];
      }
    }
  }

  sheet.updatePixels();
  return sheet;
}

// =====================
// Mosaic helpers
// =====================
function drawToSquare900(srcImg) {
  const g = createGraphics(TARGET_SIZE, TARGET_SIZE);
  g.pixelDensity(1);

  const ow = srcImg.width;
  const oh = srcImg.height;

  // scale to fill then center crop
  const scale = Math.max(TARGET_SIZE / ow, TARGET_SIZE / oh);
  const w = ow * scale;
  const h = oh * scale;

  const dx = (TARGET_SIZE - w) / 2;
  const dy = (TARGET_SIZE - h) / 2;

  g.image(srcImg, dx, dy, w, h);
  return g;
}

function nearestEmojiIndex(r, g, b) {
  let bestIdx = 0;
  let bestD = Infinity;

  for (let i = 0; i < emojiCount; i++) {
    const off = i * 3;
    const dr = r - emojiMeans[off];
    const dg = g - emojiMeans[off + 1];
    const db = b - emojiMeans[off + 2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function drawEmojiFromSheet(g, emojiIndex, dx, dy, dw, dh) {
  const col = emojiIndex % SHEET_COLS;
  const row = Math.floor(emojiIndex / SHEET_COLS);

  const sx = col * EMOJI_SIZE;
  const sy = row * EMOJI_SIZE;

  g.image(emojiSheetImg, dx, dy, dw, dh, sx, sy, EMOJI_SIZE, EMOJI_SIZE);
}

// =====================
// Core processing
// =====================
function processImage() {
  if (!uploadedImg) return;
  if (!isReady) return;

  statusMsg = "Processing image...";

  // A) crop to 900x900
  const base900 = drawToSquare900(uploadedImg);

  // B) downsample to MOSAIC_DIM x MOSAIC_DIM
  const small = base900.get();
  small.resize(MOSAIC_DIM, MOSAIC_DIM);
  small.loadPixels();

  // C) render mosaic
  const finalCanvas = createGraphics(TARGET_SIZE, TARGET_SIZE);
  finalCanvas.pixelDensity(1);
  finalCanvas.background(255);

  const cell = TARGET_SIZE / MOSAIC_DIM;

  for (let y = 0; y < MOSAIC_DIM; y++) {
    for (let x = 0; x < MOSAIC_DIM; x++) {
      const idx = (x + y * MOSAIC_DIM) * 4;
      const r = small.pixels[idx];
      const g = small.pixels[idx + 1];
      const b = small.pixels[idx + 2];
      const a = small.pixels[idx + 3];

      if (a <= 0) continue;

      const ei = nearestEmojiIndex(r, g, b);
      drawEmojiFromSheet(finalCanvas, ei, x * cell, y * cell, cell, cell);
    }
  }

  processedCanvas = finalCanvas;
  uploadedImg = null;
  statusMsg = "Done. You can save the image.";
}

// =====================
// Draw
// =====================
function draw() {
  background(255);
  fill(0);
  textSize(18);
  text(statusMsg, width / 2, 120);

  if (processedCanvas) {
    image(processedCanvas, 0, UI_HEIGHT);
  }
}

// =====================
// Save
// =====================
function saveImage() {
  if (processedCanvas) {
    save(processedCanvas, "emojified_image", "png");
  } else {
    alert("请先上传图片并等待处理完成！");
  }
}
