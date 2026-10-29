@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var nearest: sampler;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) vertex: u32) -> Vertex {
  let uv = array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[vertex];
  return Vertex(vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,0,1),uv);
}
@fragment fn fs(v: Vertex) -> @location(0) vec4f { return textureSample(image,nearest,v.uv); }
