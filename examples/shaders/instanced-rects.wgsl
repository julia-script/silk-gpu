struct Rect { bounds: vec4f, color: vec4f, rounding: vec4f }
@group(0) @binding(0) var<storage, read> rects: array<Rect>;
struct Vertex { @builtin(position) position: vec4f, @location(0) local: vec2f, @location(1) @interpolate(flat) index: u32 }
@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Vertex {
  let corners = array<vec2f, 6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  let r = rects[instance];
  let local = corners[vertex] * r.bounds.zw;
  let pixel = r.bounds.xy + local;
  return Vertex(vec4f(pixel.x / 32.0 - 1.0, 1.0 - pixel.y / 32.0, 0, 1), local, instance);
}
@fragment fn fs(v: Vertex) -> @location(0) vec4f {
  let r = rects[v.index];
  let q = abs(v.local - r.bounds.zw * 0.5) - (r.bounds.zw * 0.5 - vec2f(r.rounding.x));
  let distance = length(max(q,vec2f(0))) + min(max(q.x,q.y),0.0) - r.rounding.x;
  if distance > 0.0 { discard; }
  return r.color;
}
