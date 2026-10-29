// Sparse-strip scene renderer: one instance per strip or fill run, painted and composited
// source-over with exact integer masking so output matches vector's CPU pixmap.
struct Canvas { width: u32, height: u32, runs: u32, unused: u32 }
struct Run { x: u32, y: u32, width: u32, alpha: u32, paint: u32, opacity: u32 }
@group(0) @binding(0) var<uniform> canvas: Canvas;
@group(0) @binding(1) var<storage, read> runs: array<Run>;
@group(0) @binding(2) var<storage, read> alphas: array<u32>;
@group(0) @binding(3) var<storage, read> paints: array<u32>;
@group(0) @binding(4) var<storage, read> ramps: array<u32>;

const BAND: u32 = 4u;
const SOLID_RUN: u32 = 0xffffffffu;
const RAMP_LAST: f32 = 1023.0;

struct Vertex { @builtin(position) position: vec4f, @location(0) @interpolate(flat) run: u32 }

@vertex fn vs(@builtin(vertex_index) corner: u32, @builtin(instance_index) index: u32) -> Vertex {
  let r = runs[index];
  let corners = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u), vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u));
  let c = corners[corner];
  let x = f32(r.x + c.x * r.width);
  let y = f32(min(r.y + c.y * BAND, canvas.height));
  return Vertex(vec4f(x / f32(canvas.width) * 2.0 - 1.0, 1.0 - y / f32(canvas.height) * 2.0, 0.0, 1.0), index);
}

fn div255(x: u32) -> u32 {
  let t = x + 128u;
  return (t + (t >> 8u)) >> 8u;
}

fn unpack(c: u32) -> vec4u {
  return vec4u(c & 255u, (c >> 8u) & 255u, (c >> 16u) & 255u, c >> 24u);
}

fn word(p: u32, i: u32) -> f32 { return bitcast<f32>(paints[p + i]); }

// Image paints (kind 3): texel start in `ramps`, width, height, the device-to-image inverse
// a b c d e f, sampling (0 nearest, 1 bilinear), extend (0 clamp, 1 repeat).
// Native SceneRenderer compiles this module with strict math: relaxed contraction/reassociation
// can move a transformed coordinate across a nearest-texel boundary relative to vector.paint.
// Browser WGSL has no strict-math parity guarantee. Projective matrices are
// checked and normalized by the recorder; zero inverse w paints nothing.
fn texel(p: u32, x: f32, y: f32) -> vec4u {
  let w = f32(paints[p + 2u]);
  let h = f32(paints[p + 3u]);
  var tx = 0.0;
  var ty = 0.0;
  if paints[p + 11u] == 1u {
    // Rounding can land exactly on w or h; keep the index inside the image.
    tx = min(x - w * floor(x / w), w - 1.0);
    ty = min(y - h * floor(y / h), h - 1.0);
  } else {
    tx = clamp(x, 0.0, w - 1.0);
    ty = clamp(y, 0.0, h - 1.0);
  }
  let index = u32(ty) * paints[p + 2u] + u32(tx);
  return unpack(ramps[paints[p + 1u] + index]);
}

fn bilerp(a: vec4u, b: vec4u, c: vec4u, d: vec4u, wx: f32, wy: f32) -> vec4u {
  let top = vec4f(a) + (vec4f(b) - vec4f(a)) * wx;
  let bottom = vec4f(c) + (vec4f(d) - vec4f(c)) * wx;
  return vec4u(floor(top + (bottom - top) * wy + 0.5));
}

// Match vector.paint's explicit one-rounding operations. Plain multiply/add can
// contract at a different point on Metal even with the module's strictMath flag.
fn projectiveImagePoint(p: u32, fx: f32, fy: f32) -> vec3f {
  let first = fma(vec3f(word(p, 4u), word(p, 5u), word(p, 16u)), vec3f(fx),
    vec3f(word(p, 8u), word(p, 9u), word(p, 18u)));
  return fma(vec3f(word(p, 6u), word(p, 7u), word(p, 17u)), vec3f(fy), first);
}

fn shadeImage(p: u32, pixel: vec2u) -> vec4u {
  let fx = f32(pixel.x) + 0.5;
  let fy = f32(pixel.y) + 0.5;
  var x = 0.0;
  var y = 0.0;
  if paints[p] == 6u {
    let mapped = projectiveImagePoint(p, fx, fy);
    let w = mapped.z;
    if w == 0.0 || !(abs(w) <= 3.402823e38) { return vec4u(0u); }
    x = mapped.x / w;
    y = mapped.y / w;
  } else {
    x = word(p, 4u) * fx + word(p, 6u) * fy + word(p, 8u);
    y = word(p, 5u) * fx + word(p, 7u) * fy + word(p, 9u);
  }
  if abs(x) > 1.0e15 || abs(y) > 1.0e15 || x != x || y != y { return vec4u(0u); }
  if paints[p + 10u] == 0u { return texel(p, floor(x), floor(y)); }
  let x0 = floor(x - 0.5);
  let y0 = floor(y - 0.5);
  let wx = x - 0.5 - x0;
  let wy = y - 0.5 - y0;
  return bilerp(texel(p, x0, y0), texel(p, x0 + 1.0, y0), texel(p, x0, y0 + 1.0), texel(p, x0 + 1.0, y0 + 1.0), wx, wy);
}

// Solid/affine records are 16 words: kind (0 solid, 1 linear, 2 radial, 3 image),
// color or ramp start, spread, flags (bit0 single, bit1 tangent limit), inverse a b c d e f, then x0 y0 r0 x1 y1 r1.
// Projective kinds 4 linear, 5 radial, 6 image append inverse wx wy ww (19 words).
// Runs carry word offsets, so mixed affine/projective records need no padding.
fn shade(p: u32, pixel: vec2u) -> vec4u {
  let kind = paints[p];
  if kind == 0u { return unpack(paints[p + 1u]); }
  if kind == 3u || kind == 6u { return shadeImage(p, pixel); }
  var index = 1023u;
  if (paints[p + 3u] & 1u) == 0u || kind >= 4u {
    let fx = f32(pixel.x) + 0.5;
    let fy = f32(pixel.y) + 0.5;
    var gx = word(p, 4u) * fx + word(p, 6u) * fy + word(p, 8u);
    var gy = word(p, 5u) * fx + word(p, 7u) * fy + word(p, 9u);
    if kind >= 4u {
      let w = word(p, 16u) * fx + word(p, 17u) * fy + word(p, 18u);
      if w == 0.0 || !(abs(w) <= 3.402823e38) { return vec4u(0u); }
      gx = gx / w;
      gy = gy / w;
      if !(abs(gx) <= 3.402823e38) || !(abs(gy) <= 3.402823e38) { return vec4u(0u); }
      if (paints[p + 3u] & 1u) != 0u { return unpack(ramps[paints[p + 1u] + index]); }
    }
    let x0 = word(p, 10u);
    let y0 = word(p, 11u);
    let r0 = word(p, 12u);
    let x1 = word(p, 13u);
    let y1 = word(p, 14u);
    let r1 = word(p, 15u);
    var t = 0.0;
    if kind == 1u || kind == 4u {
      let dx = x1 - x0;
      let dy = y1 - y0;
      t = ((gx - x0) * dx + (gy - y0) * dy) / (dx * dx + dy * dy);
    } else {
      let cdx = x1 - x0;
      let cdy = y1 - y0;
      let dr = r1 - r0;
      let pdx = gx - x0;
      let pdy = gy - y0;
      let a = cdx * cdx + cdy * cdy - dr * dr;
      let b = pdx * cdx + pdy * cdy + r0 * dr;
      let c = pdx * pdx + pdy * pdy - r0 * r0;
      if (paints[p + 3u] & 2u) != 0u {
        if b == 0.0 || ((b < 0.0) == (dr > 0.0)) {
          return unpack(ramps[paints[p + 1u] + 1024u]);
        }
        t = c / (2.0 * b);
      } else {
        let disc = b * b - a * c;
        if disc < 0.0 { return vec4u(0u); }
        let root = sqrt(disc);
        let t1 = max((b + root) / a, (b - root) / a);
        let t2 = min((b + root) / a, (b - root) / a);
        if r0 + t1 * dr >= 0.0 {
          t = t1;
        } else if r0 + t2 * dr >= 0.0 {
          t = t2;
        } else {
          return vec4u(0u);
        }
      }
    }
    if !(abs(t) <= 3.402823e38) { return vec4u(0u); }
    let spread = paints[p + 2u];
    var s = clamp(t, 0.0, 1.0);
    if spread == 2u {
      s = t - floor(t);
    } else if spread == 1u {
      let m = t - 2.0 * floor(t * 0.5);
      s = select(m, 2.0 - m, m > 1.0);
    }
    index = u32(floor(s * RAMP_LAST + 0.5));
  }
  return unpack(ramps[paints[p + 1u] + index]);
}

@fragment fn fs(v: Vertex) -> @location(0) vec4f {
  let r = runs[v.run];
  let pixel = vec2u(v.position.xy);
  var alpha = 255u;
  if r.alpha != SOLID_RUN {
    alpha = (alphas[r.alpha + pixel.x - r.x] >> (8u * (pixel.y - r.y))) & 255u;
  }
  let mask = div255(alpha * r.opacity);
  if mask == 0u { discard; }
  let c = shade(r.paint, pixel);
  let s = vec4u(div255(c.x * mask), div255(c.y * mask), div255(c.z * mask), div255(c.w * mask));
  return vec4f(s) / 255.0;
}
