// Blend-mode math shared by compose.wgsl and filter.wgsl (scripts/embed-shaders prepends it),
// matching vector.layer on premultiplied bytes.

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

fn div255(x: u32) -> u32 {
  let t = x + 128u;
  return (t + (t >> 8u)) >> 8u;
}

fn bytes(t: texture_2d<f32>, pixel: vec2u) -> vec4u {
  return vec4u(round(textureLoad(t, pixel, 0) * 255.0));
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
