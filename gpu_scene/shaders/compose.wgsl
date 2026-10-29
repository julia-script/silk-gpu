// Layer composition passes, matching vector.layer on the CPU: composite a group onto a copy of its
// parent (blend modes, group opacity, masks), turn mask content into a mask, or copy a layer out.
// Prepended with blend.wgsl.
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

@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  // One triangle covering the target.
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn scale(c: vec4u, m: u32) -> vec4u {
  if m == 255u { return c; }
  return vec4u(div255(c.x * m), div255(c.y * m), div255(c.z * m), div255(c.w * m));
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
