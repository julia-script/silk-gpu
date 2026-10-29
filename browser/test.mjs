#!/usr/bin/env node
// Uses the already installed Playwright and Chromium; never downloads a browser.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) throw new Error('Usage: node browser/test.mjs --wasm FILE --fixtures MANIFEST.json [--timeout 30000]');
  options.set(process.argv[i], process.argv[i + 1]);
}
if (!options.has('--wasm') || !options.has('--fixtures')) throw new Error('--wasm and --fixtures are required; browser tests execute compiled Silk samples');
const wasm = await readFile(resolve(options.get('--wasm')));
const manifestPath = resolve(options.get('--fixtures'));
const fixtures = JSON.parse(await readFile(manifestPath, 'utf8'));
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); }
catch (error) { throw new Error('An existing Playwright installation is required (set PLAYWRIGHT_MODULE to its installed absolute module path); do not run playwright install', { cause: error }); }

// Independent PNG decoder for committed RGBA8/RGB8 fixture images. Implements all
// five scanline filters; unsupported PNG encodings fail instead of approximating.
function png(bytes) {
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Fixture is not PNG');
  let width, height, channels;
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (data[8] !== 8 || !channels || data[10] || data[11] || data[12]) throw new Error('Fixtures must be noninterlaced RGB8 or RGBA8 PNG');
    }
    if (type === 'IDAT') chunks.push(data);
    offset += length + 12;
    if (type === 'IEND') break;
  }
  const packed = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  if (packed.length !== (stride + 1) * height) throw new Error('PNG scanline length mismatch');
  const decoded = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)];
    if (filter > 4) throw new Error(`Invalid PNG filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? decoded[y * stride + x - channels] : 0;
      const up = y ? decoded[(y - 1) * stride + x] : 0;
      const corner = y && x >= channels ? decoded[(y - 1) * stride + x - channels] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      if (filter === 2) prediction = up;
      if (filter === 3) prediction = Math.floor((left + up) / 2);
      if (filter === 4) {
        const p = left + up - corner;
        const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
        prediction = a <= b && a <= c ? left : b <= c ? up : corner;
      }
      decoded[y * stride + x] = packed[y * (stride + 1) + 1 + x] + prediction;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba.set(decoded.subarray(i * channels, i * channels + 3), i * 4);
    rgba[i * 4 + 3] = channels === 4 ? decoded[i * 4 + 3] : 255;
  }
  return { width, height, rgba };
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/samples.wasm') { response.setHeader('Content-Type', 'application/wasm'); response.end(wasm); return; }
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Silk WebGPU test</title>'); return; }
    const path = resolve(root, '.' + decodeURIComponent(pathname));
    if (!path.startsWith(root + sep) || !['.ts', '.js'].includes(extname(path))) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'text/javascript');
    response.end(await readFile(path));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
const listening = Promise.withResolvers();
server.once('error', listening.reject);
server.listen(0, '127.0.0.1', listening.resolve);
await listening.promise;
let browser;
try {
  // A supplied executable is authoritative: Playwright fails if it is missing;
  // it must not silently switch to a bundled or downloaded browser.
  browser = await chromium.launch({ headless: process.platform !== 'linux',
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: [
    // Preserve Playwright's screenshot surface feature when enabling Vulkan.
    '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan,CDPScreenshotNewSurface',
    '--disable-vulkan-surface', '--enable-unsafe-swiftshader',
    // Linux's system Vulkan loader may have no usable ICD even when ANGLE's
    // SwiftShader works. The compositor needs the same software Vulkan driver.
    ...(process.platform === 'linux' ? ['--use-vulkan=swiftshader'] : []),
  ] });
  console.log(`Chromium ${browser.version()} (${process.platform}): compiled Silk WebGPU tests`);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') console.error(`[Chromium ${message.type()}] ${message.text()}`);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const results = await page.evaluate(async ({ indices, timeout }) => {
    const { runSamples } = await import('/browser/runner.ts');
    return await runSamples('/samples.wasm', indices, timeout);
  }, { indices: fixtures.samples.map(sample => sample.index), timeout: Number(options.get('--timeout') ?? 30000) });
  if (errors.length) throw new Error(errors.join('\n'));
  for (const result of results) {
    const fixture = fixtures.samples.find(sample => sample.index === result.index);
    if (result.compute) {
      const { count, multiplier, addend } = fixture.compute;
      if (result.compute.length !== count || result.compute.some((value, i) => value !== Math.imul(i, multiplier) + addend))
        throw new Error(`${fixture.name}: compute results differ`);
    }
    {
      const expected = png(await readFile(resolve(dirname(manifestPath), fixture.png)));
      if (result.width !== expected.width || result.height !== expected.height) throw new Error(`${fixture.name}: image dimensions differ`);
      let different = 0;
      const tolerance = fixture.tolerance ?? 2;
      for (let pixel = 0; pixel < expected.width * expected.height; pixel++) {
        if ([0, 1, 2, 3].some(channel => Math.abs(result.rgba[pixel * 4 + channel] - expected.rgba[pixel * 4 + channel]) > tolerance)) different++;
      }
      if (different > (fixture.maxDifferentPixels ?? 0)) throw new Error(`${fixture.name}: ${different} pixels exceed per-channel tolerance ${tolerance}`);
    }
    console.log(`PASS ${fixture.name}: compiled Silk wasm, validation and handle checks`);
  }
  const canvasResult = await page.evaluate(async () => {
    const { runCanvas } = await import('/browser/canvas-test.ts');
    const bytes = await (await fetch('/samples.wasm')).arrayBuffer();
    globalThis.canvasCheck = await runCanvas(bytes);
    return { frames: globalThis.canvasCheck.frames, rgba: globalThis.canvasCheck.expectedRGBA };
  });
  try {
    const screenshot = await page.locator('#gpu-test').screenshot();
    await mkdir(resolve(root, '.cache/pixels'), { recursive: true });
    await writeFile(resolve(root, '.cache/pixels/browser-canvas.png'), screenshot);
    const actual = png(screenshot);
    const finalFrame = canvasResult.frames.at(-1);
    if (actual.width !== finalFrame.width || actual.height !== finalFrame.height)
      throw new Error('Canvas presentation dimensions do not match the resized surface');
    for (let pixel = 0; pixel < actual.width * actual.height; pixel++) {
      if (canvasResult.rgba.some((value, channel) => Math.abs(actual.rgba[pixel * 4 + channel] - value) > 2))
        throw new Error(`Canvas presentation differs at pixel ${pixel}: expected RGBA ${canvasResult.rgba}, actual ${[...actual.rgba.subarray(pixel * 4, pixel * 4 + 4)]}`);
    }
  } finally {
    await page.evaluate(async () => {
      await globalThis.canvasCheck.cleanup();
      delete globalThis.canvasCheck;
    });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PASS canvas: compiled Silk configure/present/resize, compositor pixels, validation and cleanup');
} finally {
  await browser?.close();
  const closed = Promise.withResolvers();
  server.close(closed.resolve);
  await closed.promise;
}
