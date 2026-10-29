//! tiny-skia side of the vector CPU benchmark; see bench/vector/WORKLOADS.md.
use std::time::Instant;
use tiny_skia::*;

const PI: f64 = std::f64::consts::PI;

struct Random(u64);
impl Random {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / 9007199254740992.0
    }
    fn byte(&mut self) -> u8 {
        (self.next() * 255.0).floor() as u8
    }
}

fn circle(pb: &mut PathBuilder, cx: f64, cy: f64, r: f64) {
    let k = r * 0.5522847498307936;
    let p = |x: f64, y: f64| (x as f32, y as f32);
    let (x, y) = p(cx + r, cy);
    pb.move_to(x, y);
    let segs = [
        (cx + r, cy + k, cx + k, cy + r, cx, cy + r),
        (cx - k, cy + r, cx - r, cy + k, cx - r, cy),
        (cx - r, cy - k, cx - k, cy - r, cx, cy - r),
        (cx + k, cy - r, cx + r, cy - k, cx + r, cy),
    ];
    for (a, b, c, d, e, f) in segs {
        pb.cubic_to(a as f32, b as f32, c as f32, d as f32, e as f32, f as f32);
    }
    pb.close();
}

fn star(pb: &mut PathBuilder, cx: f64, cy: f64, outer: f64, inner: f64) {
    for i in 0..10 {
        let angle = i as f64 * PI / 5.0 - PI / 2.0;
        let r = if i % 2 == 0 { outer } else { inner };
        let (x, y) = ((cx + r * angle.cos()) as f32, (cy + r * angle.sin()) as f32);
        if i == 0 { pb.move_to(x, y) } else { pb.line_to(x, y) }
    }
    pb.close();
}

fn solid(r: u8, g: u8, b: u8, a: u8) -> Paint<'static> {
    let mut paint = Paint::default();
    paint.set_color_rgba8(r, g, b, a);
    paint.anti_alias = true;
    paint
}

fn fills(target: &mut Pixmap) {
    let mut random = Random(7);
    for _ in 0..300 {
        let (cx, cy, radius) = (random.next() * 512.0, random.next() * 512.0, 4.0 + random.next() * 60.0);
        let (r, g, b) = (random.byte(), random.byte(), random.byte());
        let a = (128.0 + 127.0 * random.next()).floor() as u8;
        let mut pb = PathBuilder::new();
        circle(&mut pb, cx, cy, radius);
        let path = pb.finish().unwrap();
        target.fill_path(&path, &solid(r, g, b, a), FillRule::Winding, Transform::identity(), None);
    }
}

fn strokes(target: &mut Pixmap) {
    let mut random = Random(7);
    for _ in 0..150 {
        let (cx, cy, outer) = (random.next() * 512.0, random.next() * 512.0, 10.0 + random.next() * 50.0);
        let width = 1.0 + random.next() * 6.0;
        let (r, g, b) = (random.byte(), random.byte(), random.byte());
        let mut pb = PathBuilder::new();
        star(&mut pb, cx, cy, outer, outer * 0.4);
        let path = pb.finish().unwrap();
        let stroke = Stroke { width: width as f32, line_join: LineJoin::Round, line_cap: LineCap::Butt, ..Stroke::default() };
        target.stroke_path(&path, &solid(r, g, b, 255), &stroke, Transform::identity(), None);
    }
}

fn gradients(target: &mut Pixmap) {
    let mut random = Random(7);
    for i in 0..100 {
        let (x, y) = (random.next() * 462.0, random.next() * 462.0);
        let (w, h) = (10.0 + random.next() * 90.0, 10.0 + random.next() * 90.0);
        let mut stops = Vec::new();
        for offset in [0.0f32, 0.5, 1.0] {
            let (r, g, b) = (random.byte(), random.byte(), random.byte());
            stops.push(GradientStop::new(offset, Color::from_rgba8(r, g, b, 255)));
        }
        let shader = if i % 2 == 0 {
            LinearGradient::new(Point::from_xy(x as f32, y as f32), Point::from_xy((x + w) as f32, (y + h) as f32), stops, SpreadMode::Pad, Transform::identity())
        } else {
            let c = Point::from_xy((x + w * 0.5) as f32, (y + h * 0.5) as f32);
            RadialGradient::new(c, c, (w.max(h) * 0.5) as f32, stops, SpreadMode::Pad, Transform::identity())
        }
        .unwrap();
        let mut paint = Paint::default();
        paint.shader = shader;
        paint.anti_alias = true;
        let rect = Rect::from_xywh(x as f32, y as f32, w as f32, h as f32).unwrap();
        target.fill_rect(rect, &paint, Transform::identity(), None);
    }
}

fn polygon(target: &mut Pixmap) {
    let mut random = Random(7);
    let mut pb = PathBuilder::new();
    for i in 0..4000 {
        let angle = 2.0 * PI * i as f64 / 4000.0 * 37.0;
        let radius = 30.0 + 220.0 * random.next();
        let (x, y) = ((256.0 + radius * angle.cos()) as f32, (256.0 + radius * angle.sin()) as f32);
        if i == 0 { pb.move_to(x, y) } else { pb.line_to(x, y) }
    }
    pb.close();
    let path = pb.finish().unwrap();
    target.fill_path(&path, &solid(20, 40, 160, 255), FillRule::EvenOdd, Transform::identity(), None);
}

fn icons(target: &mut Pixmap) {
    let mut random = Random(7);
    for i in 0..4000 {
        let (cx, cy, size) = (random.next() * 512.0, random.next() * 512.0, 2.0 + random.next() * 10.0);
        let (r, g, b) = (random.byte(), random.byte(), random.byte());
        let mut pb = PathBuilder::new();
        if i % 2 == 0 { circle(&mut pb, cx, cy, size) } else { star(&mut pb, cx, cy, size, size * 0.4) }
        let path = pb.finish().unwrap();
        target.fill_path(&path, &solid(r, g, b, 255), FillRule::Winding, Transform::identity(), None);
    }
}

fn tile() -> Pixmap {
    let mut image = Pixmap::new(64, 64).unwrap();
    let d = image.data_mut();
    for y in 0..64u32 {
        for x in 0..64u32 {
            let i = ((y * 64 + x) * 4) as usize;
            let dark = ((x / 8) + (y / 8)) % 2 == 0;
            d[i] = if dark { x * 2 } else { 255 - x * 2 } as u8;
            d[i + 1] = if dark { y * 3 } else { 250 - y * 3 } as u8;
            d[i + 2] = if dark { 40 } else { 200 };
            d[i + 3] = 255;
        }
    }
    image
}

fn images(target: &mut Pixmap, image: &Pixmap) {
    let mut random = Random(7);
    for _ in 0..60 {
        let (x, y) = (random.next() * 412.0, random.next() * 412.0);
        let (w, h) = (20.0 + random.next() * 80.0, 20.0 + random.next() * 80.0);
        let angle = random.next() * PI;
        let scale = 0.5 + random.next() * 1.5;
        let (cos, sin) = (angle.cos() * scale, angle.sin() * scale);
        let placement = Transform::from_row(cos as f32, sin as f32, -sin as f32, cos as f32, x as f32, y as f32);
        let mut paint = Paint::default();
        paint.shader = Pattern::new(image.as_ref(), SpreadMode::Repeat, FilterQuality::Bilinear, 1.0, placement);
        paint.anti_alias = true;
        let rect = Rect::from_xywh(x as f32, y as f32, w as f32, h as f32).unwrap();
        target.fill_rect(rect, &paint, Transform::identity(), None);
    }
}

fn main() {
    let frames: usize = std::env::args().nth(1).and_then(|v| v.parse().ok()).unwrap_or(20);
    let mut target = Pixmap::new(512, 512).unwrap();
    let image = tile();
    let scenes: [(&str, &dyn Fn(&mut Pixmap)); 6] = [
        ("fills", &fills), ("strokes", &strokes), ("gradients", &gradients), ("polygon", &polygon), ("icons", &icons),
        ("images", &|target: &mut Pixmap| images(target, &image)),
    ];
    for (name, draw) in scenes {
        let mut times = Vec::new();
        for _ in 0..frames {
            let start = Instant::now();
            target.fill(Color::WHITE);
            draw(&mut target);
            times.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        eprintln!("{} {}", name, times[frames / 2]);
        std::fs::write(format!("tiny-skia-{}.rgba", name), target.data()).unwrap();
    }
}
