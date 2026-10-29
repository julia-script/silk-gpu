// Layer composition passes, matching vector.layer on the CPU: composite a group onto a copy of its
// parent (blend modes, group opacity, masks), turn mask content into a mask, or copy a layer out.
struct Params { op: u32, mode: u32, opacity: u32, flags: u32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var backdrop: texture_2d<f32>;
@group(0) @binding(2) var layer: texture_2d<f32>;
@group(0) @binding(3) var mask: texture_2d<f32>;

const OP_COMPOSITE: u32 = 0u;
const OP_MASK: u32 = 1u;
const OP_COPY: u32 = 2u;
// flags: bit 0 = a mask is bound, bit 1 = luminance (OP_MASK).
const HAS_MASK: u32 = 1u;
const LUMINANCE: u32 = 2u;

const NORMAL: u32 = 0u;
const MULTIPLY: u32 = 1u;
const SCREEN: u32 = 2u;
const OVERLAY: u32 = 3u;
const DARKEN: u32 = 4u;
const LIGHTEN: u32 = 5u;
const COLOR_DODGE: u32 = 6u;
const COLOR_BURN: u32 = 7u;
const HARD_LIGHT: u32 = 8u;
const SOFT_LIGHT: u32 = 9u;
const DIFFERENCE: u32 = 10u;
const EXCLUSION: u32 = 11u;
const HUE: u32 = 12u;
const SATURATION: u32 = 13u;
const COLOR: u32 = 14u;

@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  // One triangle covering the target.
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn div255(x: u32) -> u32 {
  let t = x + 128u;
  return (t + (t >> 8u)) >> 8u;
}

fn bytes(t: texture_2d<f32>, pixel: vec2u) -> vec4u {
  return vec4u(round(textureLoad(t, pixel, 0) * 255.0));
}

fn scale(c: vec4u, m: u32) -> vec4u {
  if m == 255u { return c; }
  return vec4u(div255(c.x * m), div255(c.y * m), div255(c.z * m), div255(c.w * m));
}

fn toByte(v: f32) -> u32 { return u32(floor(clamp(v, 0.0, 1.0) * 255.0 + 0.5)); }

fn hardLight(cb: f32, cs: f32) -> f32 {
  if cs <= 0.5 { return cb * 2.0 * cs; }
  let s = 2.0 * cs - 1.0;
  return cb + s - cb * s;
}

fn separable(cb: f32, cs: f32, mode: u32) -> f32 {
  switch mode {
    case MULTIPLY: { return cb * cs; }
    case SCREEN: { return cb + cs - cb * cs; }
    case OVERLAY: { return hardLight(cs, cb); }
    case DARKEN: { return min(cb, cs); }
    case LIGHTEN: { return max(cb, cs); }
    case COLOR_DODGE: {
      if cb == 0.0 { return 0.0; }
      if cs >= 1.0 { return 1.0; }
      return min(1.0, cb / (1.0 - cs));
    }
    case COLOR_BURN: {
      if cb >= 1.0 { return 1.0; }
      if cs <= 0.0 { return 0.0; }
      return 1.0 - min(1.0, (1.0 - cb) / cs);
    }
    case HARD_LIGHT: { return hardLight(cb, cs); }
    case SOFT_LIGHT: {
      if cs <= 0.5 { return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb); }
      var d = sqrt(cb);
      if cb <= 0.25 { d = ((16.0 * cb - 12.0) * cb + 4.0) * cb; }
      return cb + (2.0 * cs - 1.0) * (d - cb);
    }
    case DIFFERENCE: { return abs(cb - cs); }
    case EXCLUSION: { return cb + cs - 2.0 * cb * cs; }
    default: { return cs; }
  }
}

fn lum(c: vec3f) -> f32 { return 0.3 * c.x + 0.59 * c.y + 0.11 * c.z; }

fn clipColor(c: vec3f) -> vec3f {
  let l = lum(c);
  let n = min(c.x, min(c.y, c.z));
  let x = max(c.x, max(c.y, c.z));
  var r = c;
  if n < 0.0 { r = l + (r - l) * l / (l - n); }
  if x > 1.0 { r = l + (r - l) * (1.0 - l) / (x - l); }
  return r;
}

fn setLum(c: vec3f, l: f32) -> vec3f { return clipColor(c + (l - lum(c))); }

fn sat(c: vec3f) -> f32 { return max(c.x, max(c.y, c.z)) - min(c.x, min(c.y, c.z)); }

fn setSat(c: vec3f, s: f32) -> vec3f {
  let mx = max(c.x, max(c.y, c.z));
  let mn = min(c.x, min(c.y, c.z));
  if mx <= mn { return vec3f(0.0); }
  return (c - mn) * s / (mx - mn);
}

// co = cs (1 - ab) + cb (1 - as) + as ab B(Cb, Cs), ao = as + ab (1 - as), on premultiplied bytes.
fn blend(b: vec4u, s: vec4u, mode: u32) -> vec4u {
  if mode == NORMAL {
    let inverse = 255u - s.w;
    return s + vec4u(div255(b.x * inverse), div255(b.y * inverse), div255(b.z * inverse), div255(b.w * inverse));
  }
  let sa = f32(s.w) / 255.0;
  let ba = f32(b.w) / 255.0;
  if sa == 0.0 { return b; }
  let sc = vec3f(f32(s.x) / 255.0, f32(s.y) / 255.0, f32(s.z) / 255.0);
  let bc = vec3f(f32(b.x) / 255.0, f32(b.y) / 255.0, f32(b.z) / 255.0);
  let cs = sc / sa;
  var cb = vec3f(0.0);
  if ba > 0.0 { cb = bc / ba; }
  var r = vec3f(0.0);
  if mode == HUE {
    r = setLum(setSat(cs, sat(cb)), lum(cb));
  } else if mode == SATURATION {
    r = setLum(setSat(cb, sat(cs)), lum(cb));
  } else if mode == COLOR {
    r = setLum(cs, lum(cb));
  } else if mode > COLOR {
    r = setLum(cb, lum(cs));
  } else {
    r = vec3f(separable(cb.x, cs.x, mode), separable(cb.y, cs.y, mode), separable(cb.z, cs.z, mode));
  }
  let k = sa * ba;
  let o = sc * (1.0 - ba) + bc * (1.0 - sa) + k * r;
  return vec4u(toByte(o.x), toByte(o.y), toByte(o.z), toByte(sa + ba * (1.0 - sa)));
}

@fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = vec2u(position.xy);
  let content = bytes(layer, pixel);
  if params.op == OP_COPY { return vec4f(content) / 255.0; }
  var m = 255u;
  if (params.flags & HAS_MASK) != 0u { m = bytes(mask, pixel).w; }
  if params.op == OP_MASK {
    var v = content.w;
    if (params.flags & LUMINANCE) != 0u {
      // Fixed point with weights summing to 65536, like Mask.fromLuminance.
      v = (13926u * content.x + 46884u * content.y + 4726u * content.z + 32768u) >> 16u;
    }
    let value = f32(div255(v * m)) / 255.0;
    return vec4f(value);
  }
  let b = bytes(backdrop, pixel);
  let level = div255(m * params.opacity);
  if level == 0u || content.w == 0u { return vec4f(b) / 255.0; }
  return vec4f(blend(b, scale(content, level), params.mode)) / 255.0;
}
