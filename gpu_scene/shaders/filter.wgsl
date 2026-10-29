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
const OP_MORPHOLOGY: u32 = 9u;
const OP_TRANSFER: u32 = 10u;
const OP_TILE: u32 = 11u;
const OP_CONVOLVE: u32 = 12u;
const OP_DISPLACE: u32 = 13u;
const OP_TURBULENCE: u32 = 14u;
const OP_LIGHTING: u32 = 15u;

const EDGE_DUPLICATE: u32 = 0u;
const EDGE_NONE: u32 = 2u;

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

fn table(c: u32, a: u32) -> u32 { return dataByte(a * 256u + c); }

fn dataByte(index: u32) -> u32 { return (data[index >> 2u] >> ((index & 3u) * 8u)) & 255u; }

fn unpremultiplyByte(c: u32, a: u32) -> u32 {
  if a == 0u { return 0u; }
  return min((c * 255u + a / 2u) / a, 255u);
}

// One axis of feMorphology: min (erode) or max (dilate) over `radius` pixels each way, with
// transparent pixels past the region.
fn morphology(pixel: vec2u) -> vec4u {
  let r = params.region;
  let horizontal = params.p0 == 1u;
  let radius = params.p1;
  let dilate = params.p2 == 1u;
  var p = pixel.y;
  var lo = r.y;
  var hi = r.w;
  if horizontal {
    p = pixel.x;
    lo = r.x;
    hi = r.z;
  }
  var v = vec4u(255u);
  if dilate || (p < lo + radius || p + radius >= hi) { v = vec4u(0u); }
  var start = lo;
  if p >= lo + radius { start = p - radius; }
  let end = min(p + radius + 1u, hi);
  for (var q = start; q < end; q++) {
    var at = vec2u(pixel.x, q);
    if horizontal { at = vec2u(q, pixel.y); }
    let c = bytes(first, at);
    if dilate { v = max(v, c); } else { v = min(v, c); }
  }
  return v;
}

// feComponentTransfer: four 256-byte tables (r, g, b, a) on unpremultiplied bytes.
fn transfer(c: vec4u) -> vec4u {
  let a = dataByte(768u + c.w);
  return vec4u(div255(dataByte(unpremultiplyByte(c.x, c.w)) * a), div255(dataByte(256u + unpremultiplyByte(c.y, c.w)) * a),
    div255(dataByte(512u + unpremultiplyByte(c.z, c.w)) * a), a);
}

// `(p - origin) mod size`, non-negative.
fn wrapIndex(p: u32, origin: u32, size: u32) -> u32 {
  if p >= origin { return (p - origin) % size; }
  let m = (origin - p) % size;
  if m == 0u { return 0u; }
  return size - m;
}

// feTile: `params.color` holds the source rectangle.
fn tile(pixel: vec2u) -> vec4u {
  let t = params.color;
  if t.z == t.x || t.w == t.y { return vec4u(0u); }
  return bytes(first, vec2u(t.x + wrapIndex(pixel.x, t.x, t.z - t.x), t.y + wrapIndex(pixel.y, t.y, t.w - t.y)));
}

fn edgePixel(x: i32, y: i32, edgeMode: u32) -> vec4u {
  let r = vec4i(params.region);
  let w = r.z - r.x;
  let h = r.w - r.y;
  var px = x - r.x;
  var py = y - r.y;
  if px < 0 || py < 0 || px >= w || py >= h {
    if edgeMode == EDGE_NONE { return vec4u(0u); }
    if edgeMode == EDGE_DUPLICATE {
      px = clamp(px, 0, w - 1);
      py = clamp(py, 0, h - 1);
    } else {
      px = ((px % w) + w) % w;
      py = ((py % h) + h) % h;
    }
  }
  return bytes(first, vec2u(u32(r.x + px), u32(r.y + py)));
}

// feConvolveMatrix: p0 orderX, p1 orderY, p2 edge mode | preserveAlpha << 8, color.xy the
// target, k.x the divisor, k.y the bias, data the kernel as f32 bits.
fn convolve(pixel: vec2u) -> vec4u {
  let orderX = params.p0;
  let orderY = params.p1;
  let edgeMode = params.p2 & 255u;
  let preserveAlpha = (params.p2 >> 8u) != 0u;
  let divisor = params.k.x;
  let bias = params.k.y;
  var sr = 0.0;
  var sg = 0.0;
  var sb = 0.0;
  var sa = 0.0;
  for (var i = 0u; i < orderY; i++) {
    for (var j = 0u; j < orderX; j++) {
      let c = edgePixel(i32(pixel.x) - i32(params.color.x) + i32(j), i32(pixel.y) - i32(params.color.y) + i32(i), edgeMode);
      let w = bitcast<f32>(data[(orderY - i - 1u) * orderX + (orderX - j - 1u)]);
      if preserveAlpha {
        sr = sr + w * f32(unpremultiplyByte(c.x, c.w));
        sg = sg + w * f32(unpremultiplyByte(c.y, c.w));
        sb = sb + w * f32(unpremultiplyByte(c.z, c.w));
      } else {
        sr = sr + w * f32(c.x);
        sg = sg + w * f32(c.y);
        sb = sb + w * f32(c.z);
        sa = sa + w * f32(c.w);
      }
    }
  }
  // Sums are of weights times bytes; they scale to 0..=1 once, as on the CPU.
  sr = sr / 255.0;
  sg = sg / 255.0;
  sb = sb / 255.0;
  sa = sa / 255.0;
  if preserveAlpha {
    let a = bytes(first, pixel).w;
    return vec4u(div255(byte(clamp01(sr / divisor + bias)) * a), div255(byte(clamp01(sg / divisor + bias)) * a),
      div255(byte(clamp01(sb / divisor + bias)) * a), a);
  }
  let alpha = clamp01(sa / divisor + bias);
  return vec4u(byte(min(clamp01(sr / divisor + bias * alpha), alpha)), byte(min(clamp01(sg / divisor + bias * alpha), alpha)),
    byte(min(clamp01(sb / divisor + bias * alpha), alpha)), byte(alpha));
}

fn channelOf(c: vec4u, channel: u32) -> u32 {
  if channel == 3u { return c.w; }
  return unpremultiplyByte(c[channel], c.w);
}

// feDisplacementMap: `second` is the map, data the per-byte displacement, p0/p1 the channels.
fn displace(pixel: vec2u) -> vec4u {
  let m = bytes(second, pixel);
  let source = vec2i(pixel) + vec2i(bitcast<i32>(data[channelOf(m, params.p0)]), bitcast<i32>(data[channelOf(m, params.p1)]));
  let size = vec2i(textureDimensions(first));
  if any(source < vec2i(0)) || any(source >= size) { return vec4u(0u); }
  return bytes(first, vec2u(source));
}

// feTurbulence, the spec's reference noise in f32. data holds the 514-entry lattice, then the
// gradients as f32 bits at 514 + (channel * 514 + index) * 2 + component. p0 is the octave
// count, p1 bit 0 fractal noise and bit 1 stitching, k.xy the (stitch-adjusted) base
// frequencies, color the stitch width, height, wrapX and wrapY, and m[0], m[1].xy the
// device-to-user transform a..f.
fn lattice(i: i32) -> i32 { return i32(data[i]); }
fn gradient(channel: u32, index: i32) -> vec2f {
  let at = 514u + (channel * 514u + u32(index)) * 2u;
  return vec2f(bitcast<f32>(data[at]), bitcast<f32>(data[at + 1u]));
}

fn noise2(channel: u32, v: vec2f, stitching: bool, stitch: vec4i) -> f32 {
  // floor(v) + 4096 equals the reference's (int)(v + 4096) without losing f32 bits to the sum.
  let cell = floor(v);
  var bx0 = i32(cell.x) + 4096;
  var by0 = i32(cell.y) + 4096;
  var bx1 = bx0 + 1;
  var by1 = by0 + 1;
  let rx0 = v.x - cell.x;
  let ry0 = v.y - cell.y;
  let rx1 = rx0 - 1.0;
  let ry1 = ry0 - 1.0;
  if stitching {
    if bx0 >= stitch.z { bx0 -= stitch.x; }
    if bx1 >= stitch.z { bx1 -= stitch.x; }
    if by0 >= stitch.w { by0 -= stitch.y; }
    if by1 >= stitch.w { by1 -= stitch.y; }
  }
  bx0 &= 255;
  bx1 &= 255;
  by0 &= 255;
  by1 &= 255;
  let i = lattice(bx0);
  let j = lattice(bx1);
  let b00 = lattice(i + by0);
  let b10 = lattice(j + by0);
  let b01 = lattice(i + by1);
  let b11 = lattice(j + by1);
  let sx = rx0 * rx0 * (3.0 - 2.0 * rx0);
  let sy = ry0 * ry0 * (3.0 - 2.0 * ry0);
  var q = gradient(channel, b00);
  let u0 = rx0 * q.x + ry0 * q.y;
  q = gradient(channel, b10);
  let v0 = rx1 * q.x + ry0 * q.y;
  let a = u0 + sx * (v0 - u0);
  q = gradient(channel, b01);
  let u1 = rx0 * q.x + ry1 * q.y;
  q = gradient(channel, b11);
  let v1 = rx1 * q.x + ry1 * q.y;
  let b = u1 + sx * (v1 - u1);
  return a + sy * (b - a);
}

fn turbulence(pixel: vec2u) -> vec4u {
  let m = params.m;
  let p = vec2f(pixel);
  let user = vec2f(m[0].x * p.x + m[0].z * p.y + m[1].x, m[0].y * p.x + m[0].w * p.y + m[1].y);
  let fractal = (params.p1 & 1u) != 0u;
  let stitching = (params.p1 & 2u) != 0u;
  var c = vec4f(0.0);
  for (var channel = 0u; channel < 4u; channel++) {
    var v = user * params.k.xy;
    var stitch = vec4i(params.color);
    var sum = 0.0;
    var ratio = 1.0;
    for (var octave = 0u; octave < params.p0; octave++) {
      let n = noise2(channel, v, stitching, stitch);
      if fractal { sum += n / ratio; } else { sum += abs(n) / ratio; }
      v *= 2.0;
      ratio *= 2.0;
      stitch = vec4i(stitch.x * 2, stitch.y * 2, 2 * stitch.z - 4096, 2 * stitch.w - 4096);
    }
    if fractal { sum = (sum + 1.0) / 2.0; }
    c[channel] = sum;
  }
  let a = byte(clamp01(c.w));
  return vec4u(div255(byte(clamp01(c.x)) * a), div255(byte(clamp01(c.y)) * a), div255(byte(clamp01(c.z)) * a), a);
}

// feDiffuseLighting and feSpecularLighting: p0 bit 0 specular, bits 8.. the light kind; k the
// surface scale, constant, exponent and cone cosine; m[0] the distant direction and spot
// exponent, m[1] the position, m[2] the spot direction, m[3] the lighting color on 0..=1.
fn alphaAt(x: u32, y: u32) -> i32 { return i32(bytes(first, vec2u(x, y)).w); }

fn normalComponent(sum: i32, span: u32, weight: i32, surfaceScale: f32) -> f32 {
  return 0.0 - surfaceScale * 2.0 / (f32(i32(span) * weight) * 255.0) * f32(sum);
}

fn surfaceNormal(x: u32, y: u32, surfaceScale: f32) -> vec2f {
  let r = params.region;
  var left = x;
  if x > r.x { left = x - 1u; }
  var right = x;
  if x + 1u < r.z { right = x + 1u; }
  var top = y;
  if y > r.y { top = y - 1u; }
  var bottom = y;
  if y + 1u < r.w { bottom = y + 1u; }
  var nx = 0.0;
  if right > left {
    var weight = 2;
    var sum = 2 * (alphaAt(right, y) - alphaAt(left, y));
    if top < y {
      sum = sum + (alphaAt(right, top) - alphaAt(left, top));
      weight = weight + 1;
    }
    if bottom > y {
      sum = sum + (alphaAt(right, bottom) - alphaAt(left, bottom));
      weight = weight + 1;
    }
    nx = normalComponent(sum, right - left, weight, surfaceScale);
  }
  var ny = 0.0;
  if bottom > top {
    var weight = 2;
    var sum = 2 * (alphaAt(x, bottom) - alphaAt(x, top));
    if left < x {
      sum = sum + (alphaAt(left, bottom) - alphaAt(left, top));
      weight = weight + 1;
    }
    if right > x {
      sum = sum + (alphaAt(right, bottom) - alphaAt(right, top));
      weight = weight + 1;
    }
    ny = normalComponent(sum, bottom - top, weight, surfaceScale);
  }
  return vec2f(nx, ny);
}

fn powUnit(base: f32, power: f32) -> f32 {
  if power == 0.0 { return 1.0; }
  if base <= 0.0 { return 0.0; }
  return pow(base, power);
}

fn lighting(pixel: vec2u) -> vec4u {
  let specular = (params.p0 & 1u) != 0u;
  let kind = params.p0 >> 8u;
  let surfaceScale = params.k.x;
  let n = surfaceNormal(pixel.x, pixel.y, surfaceScale);
  let z = surfaceScale * f32(alphaAt(pixel.x, pixel.y)) / 255.0;
  let m = params.m;
  let nLength = sqrt(n.x * n.x + n.y * n.y + 1.0);
  var l = m[0].xyz;
  if kind != 0u {
    l = m[1].xyz - vec3f(f32(pixel.x), f32(pixel.y), z);
    let length = sqrt(l.x * l.x + l.y * l.y + l.z * l.z);
    if length > 0.0 {
      let inverse = 1.0 / length;
      l = l * inverse;
    }
  }
  var scale = 1.0;
  if kind == 2u {
    let minusLDotS = 0.0 - (l.x * m[2].x + l.y * m[2].y + l.z * m[2].z);
    if minusLDotS <= 0.0 || minusLDotS < params.k.w { scale = 0.0; } else { scale = powUnit(minusLDotS, m[0].w); }
  }
  var factor = 0.0;
  if specular {
    let h = vec3f(l.x, l.y, l.z + 1.0);
    let hLength = sqrt(h.x * h.x + h.y * h.y + h.z * h.z);
    if hLength > 0.0 {
      let nDotH = (n.x * h.x + n.y * h.y + h.z) / (nLength * hLength);
      factor = params.k.y * powUnit(min(max(nDotH, 0.0), 1.0), params.k.z);
    }
  } else {
    let nDotL = (n.x * l.x + n.y * l.y + l.z) / nLength;
    factor = params.k.y * max(nDotL, 0.0);
  }
  let k = factor * scale;
  let r = clamp01(k * m[3].x);
  let g = clamp01(k * m[3].y);
  let b = clamp01(k * m[3].z);
  if !specular { return vec4u(byte(r), byte(g), byte(b), 255u); }
  let a = byte(max(r, max(g, b)));
  return vec4u(div255(byte(r) * a), div255(byte(g) * a), div255(byte(b) * a), a);
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
    case OP_MORPHOLOGY: { return emit(morphology(pixel)); }
    case OP_TRANSFER: { return emit(transfer(bytes(first, pixel))); }
    case OP_TILE: { return emit(tile(pixel)); }
    case OP_CONVOLVE: { return emit(convolve(pixel)); }
    case OP_DISPLACE: { return emit(displace(pixel)); }
    case OP_TURBULENCE: { return emit(turbulence(pixel)); }
    case OP_LIGHTING: { return emit(lighting(pixel)); }
    default: { return vec4f(0.0); }
  }
}
