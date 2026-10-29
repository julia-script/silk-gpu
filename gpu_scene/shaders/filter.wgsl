// SVG filter primitive passes, matching vector.filter on the CPU byte for byte (the matrix and
// arithmetic ones compute in f32 on both sides). Every pass writes the whole target: the result
// inside the primitive subregion, transparent black outside it (feMerge keeps what is below).
// Prepended with blend.wgsl.
struct Params {
  op: u32,
  p0: u32,
  p1: u32,
  p2: u32,
  // x0, y0, x1, y1 in device pixels.
  region: vec4u,
  // Premultiplied flood color bytes.
  color: vec4u,
  // feComposite k1..k4.
  k: vec4f,
  // feColorMatrix rows, row-major in groups of four.
  m: array<vec4f, 5>,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var first: texture_2d<f32>;
@group(0) @binding(2) var second: texture_2d<f32>;
// Blur weights (fixed point, sum 65536) or a color conversion table of packed bytes.
@group(0) @binding(3) var<storage, read> data: array<u32>;

const OP_FLOOD: u32 = 0u;
const OP_OFFSET: u32 = 1u;
const OP_MERGE: u32 = 2u;
const OP_COMPOSITE: u32 = 3u;
const OP_BLEND: u32 = 4u;
const OP_MATRIX: u32 = 5u;
const OP_BOX: u32 = 6u;
const OP_KERNEL: u32 = 7u;
const OP_CONVERT: u32 = 8u;

const COMPOSITE_IN: u32 = 1u;
const COMPOSITE_OUT: u32 = 2u;
const COMPOSITE_ATOP: u32 = 3u;
const COMPOSITE_XOR: u32 = 4u;
const COMPOSITE_LIGHTER: u32 = 5u;
const COMPOSITE_ARITHMETIC: u32 = 6u;

@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  // One triangle covering the target.
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn inside(pixel: vec2u) -> bool {
  let r = params.region;
  return pixel.x >= r.x && pixel.x < r.z && pixel.y >= r.y && pixel.y < r.w;
}

fn emit(c: vec4u) -> vec4f { return vec4f(c) / 255.0; }

fn over(s: vec4u, b: vec4u) -> vec4u {
  let inverse = 255u - s.w;
  return s + vec4u(div255(b.x * inverse), div255(b.y * inverse), div255(b.z * inverse), div255(b.w * inverse));
}

fn arithmetic(i1: u32, i2: u32, limit: f32) -> u32 {
  let a = f32(i1) / 255.0;
  let b = f32(i2) / 255.0;
  let k = params.k;
  let v = k.x * a * b + k.y * a + k.z * b + k.w;
  return u32(floor(min(max(v, 0.0), limit) * 255.0 + 0.5));
}

fn composite(s: vec4u, b: vec4u, kind: u32) -> vec4u {
  if kind == COMPOSITE_ARITHMETIC {
    let alpha = arithmetic(s.w, b.w, 1.0);
    let limit = f32(alpha) / 255.0;
    return vec4u(arithmetic(s.x, b.x, limit), arithmetic(s.y, b.y, limit), arithmetic(s.z, b.z, limit), alpha);
  }
  if kind == COMPOSITE_LIGHTER { return min(s + b, vec4u(255u)); }
  var fs = 255u;
  var fb = 255u - s.w;
  if kind == COMPOSITE_IN {
    fs = b.w;
    fb = 0u;
  } else if kind == COMPOSITE_OUT {
    fs = 255u - b.w;
    fb = 0u;
  } else if kind == COMPOSITE_ATOP {
    fs = b.w;
  } else if kind == COMPOSITE_XOR {
    fs = 255u - b.w;
  }
  let r = vec4u(div255(s.x * fs), div255(s.y * fs), div255(s.z * fs), div255(s.w * fs))
    + vec4u(div255(b.x * fb), div255(b.y * fb), div255(b.z * fb), div255(b.w * fb));
  return min(r, vec4u(255u));
}

fn clamp01(v: f32) -> f32 { return min(max(v, 0.0), 1.0); }
fn byte(v: f32) -> u32 { return u32(floor(v * 255.0 + 0.5)); }

fn matrix(c: vec4u) -> vec4u {
  let a = f32(c.w) / 255.0;
  var r = 0.0;
  var g = 0.0;
  var b = 0.0;
  if c.w != 0u {
    r = f32(c.x) / 255.0 / a;
    g = f32(c.y) / 255.0 / a;
    b = f32(c.z) / 255.0 / a;
  }
  let m = params.m;
  let ro = clamp01(m[0].x * r + m[0].y * g + m[0].z * b + m[0].w * a + m[1].x);
  let go = clamp01(m[1].y * r + m[1].z * g + m[1].w * b + m[2].x * a + m[2].y);
  let bo = clamp01(m[2].z * r + m[2].w * g + m[3].x * b + m[3].y * a + m[3].z);
  let ao = clamp01(m[3].w * r + m[4].x * g + m[4].y * b + m[4].z * a + m[4].w);
  return vec4u(byte(ro * ao), byte(go * ao), byte(bo * ao), byte(ao));
}

// The pixel `j` places from the start of the region along the blur axis, transparent past it.
fn lineSample(pixel: vec2u, j: i32) -> vec4u {
  let r = params.region;
  if params.p0 == 1u {
    let n = i32(r.z - r.x);
    if j < 0 || j >= n { return vec4u(0u); }
    return bytes(first, vec2u(r.x + u32(j), pixel.y));
  }
  let n = i32(r.w - r.y);
  if j < 0 || j >= n { return vec4u(0u); }
  return bytes(first, vec2u(pixel.x, r.y + u32(j)));
}

fn linePosition(pixel: vec2u) -> i32 {
  if params.p0 == 1u { return i32(pixel.x - params.region.x); }
  return i32(pixel.y - params.region.y);
}

// Output `i` averages inputs `i - left .. i - left + size`, rounded to nearest.
fn boxBlur(pixel: vec2u) -> vec4u {
  let size = params.p1;
  let start = linePosition(pixel) - i32(params.p2);
  var sum = vec4u(0u);
  for (var k = 0; k < i32(size); k++) { sum += lineSample(pixel, start + k); }
  return (sum + size / 2u) / size;
}

fn kernelBlur(pixel: vec2u) -> vec4u {
  let count = params.p1;
  let start = linePosition(pixel) - i32(count / 2u);
  var sum = vec4u(0u);
  for (var k = 0u; k < count; k++) { sum += lineSample(pixel, start + i32(k)) * data[k]; }
  return (sum + 32768u) >> vec4u(16u);
}

fn table(c: u32, a: u32) -> u32 {
  let index = a * 256u + c;
  return (data[index >> 2u] >> ((index & 3u) * 8u)) & 255u;
}

@fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = vec2u(position.xy);
  if params.op == OP_CONVERT {
    let c = bytes(first, pixel);
    if c.w == 0u { return emit(c); }
    return emit(vec4u(table(c.x, c.w), table(c.y, c.w), table(c.z, c.w), c.w));
  }
  if !inside(pixel) {
    if params.op == OP_MERGE { return emit(bytes(first, pixel)); }
    return vec4f(0.0);
  }
  switch params.op {
    case OP_FLOOD: { return emit(params.color); }
    case OP_OFFSET: {
      let source = vec2i(pixel) - vec2i(i32(params.p0), i32(params.p1));
      let size = vec2i(textureDimensions(first));
      if any(source < vec2i(0)) || any(source >= size) { return vec4f(0.0); }
      return emit(bytes(first, vec2u(source)));
    }
    case OP_MERGE: { return emit(over(bytes(second, pixel), bytes(first, pixel))); }
    case OP_COMPOSITE: { return emit(composite(bytes(first, pixel), bytes(second, pixel), params.p0)); }
    case OP_BLEND: {
      let s = bytes(first, pixel);
      let b = bytes(second, pixel);
      if s.w == 0u { return emit(b); }
      return emit(blend(b, s, params.p0));
    }
    case OP_MATRIX: { return emit(matrix(bytes(first, pixel))); }
    case OP_BOX: { return emit(boxBlur(pixel)); }
    case OP_KERNEL: { return emit(kernelBlur(pixel)); }
    default: { return vec4f(0.0); }
  }
}
