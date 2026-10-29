@vertex fn vs(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position,0,1); }
@fragment fn fs() -> @location(0) vec4f { return vec4f(0.25,0.75,0.5,1); }
