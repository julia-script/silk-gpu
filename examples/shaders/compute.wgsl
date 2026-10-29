@group(0) @binding(0) var<storage, read_write> values: array<u32>;
@compute @workgroup_size(64) fn compute(@builtin(global_invocation_id) id: vec3u) {
  if id.x < 4096u { values[id.x] = id.x * 3u + 7u; }
}
@group(0) @binding(1) var<storage, read> pixels: array<u32>;
@vertex fn vs(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4f(p[vertex],0,1);
}
@fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let value = pixels[u32(position.y)*64u+u32(position.x)];
  return vec4f(f32(value & 255u),f32((value >> 8u) & 255u),0,255)/255.0;
}
