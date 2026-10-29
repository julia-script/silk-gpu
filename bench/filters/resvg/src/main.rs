//! Times resvg's filters on the workloads of bench/filters/WORKLOADS.md: each SVG draws the
//! source image through one filter, and the filter's cost is the median render time minus the
//! median time of the same image drawn without the filter.
use resvg::tiny_skia::{Pixmap, Transform};
use resvg::usvg;
use std::time::Instant;

const SIZE: u32 = 512;

const WORKLOADS: [(&str, &str); 9] = [
    ("blur4", r#"<feGaussianBlur stdDeviation="4"/>"#),
    ("blur16", r#"<feGaussianBlur stdDeviation="16"/>"#),
    ("saturate", r#"<feColorMatrix type="saturate" values="0.3"/>"#),
    ("dilate3", r#"<feMorphology operator="dilate" radius="3"/>"#),
    ("gamma", r#"<feComponentTransfer><feFuncR type="gamma" amplitude="1" exponent="0.5" offset="0"/><feFuncG type="gamma" amplitude="1" exponent="0.5" offset="0"/><feFuncB type="gamma" amplitude="1" exponent="0.5" offset="0"/></feComponentTransfer>"#),
    ("sharpen", r#"<feConvolveMatrix order="3" kernelMatrix="0 -1 0 -1 5 -1 0 -1 0" edgeMode="duplicate"/>"#),
    ("turbulence", r#"<feTurbulence baseFrequency="0.02" numOctaves="4" seed="0" type="turbulence"/>"#),
    ("lighting", r#"<feDiffuseLighting surfaceScale="3" diffuseConstant="1" lighting-color="white"><fePointLight x="150" y="120" z="100"/></feDiffuseLighting>"#),
    ("displace", r#"<feDisplacementMap in="SourceGraphic" in2="SourceGraphic" scale="20" xChannelSelector="R" yChannelSelector="G"/>"#),
];

fn svg(primitive: Option<&str>) -> String {
    let (filter, attribute) = match primitive {
        Some(p) => (
            format!(r#"<filter id="f" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="0" y="0" width="{SIZE}" height="{SIZE}" color-interpolation-filters="sRGB">{p}</filter>"#),
            r#" filter="url(#f)""#,
        ),
        None => (String::new(), ""),
    };
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}">{filter}<image href="source.png" x="0" y="0" width="{SIZE}" height="{SIZE}"{attribute}/></svg>"#
    )
}

fn median_ms(tree: &usvg::Tree, frames: usize, target: &mut Pixmap) -> f64 {
    let mut times = Vec::with_capacity(frames);
    for _ in 0..frames {
        target.fill(resvg::tiny_skia::Color::TRANSPARENT);
        let start = Instant::now();
        resvg::render(tree, Transform::identity(), &mut target.as_mut());
        times.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    times[frames / 2]
}

fn main() {
    let frames: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(15);
    let source = std::fs::read("vector-source.rgba").expect("run filter_bench first");
    let image = Pixmap::from_vec(source, resvg::tiny_skia::IntSize::from_wh(SIZE, SIZE).unwrap()).unwrap();
    image.save_png("source.png").unwrap();
    let mut options = usvg::Options::default();
    options.resources_dir = Some(std::env::current_dir().unwrap());
    let mut target = Pixmap::new(SIZE, SIZE).unwrap();
    let base = usvg::Tree::from_str(&svg(None), &options).unwrap();
    let baseline = median_ms(&base, frames, &mut target);
    for (name, primitive) in WORKLOADS {
        let tree = usvg::Tree::from_str(&svg(Some(primitive)), &options).unwrap();
        let total = median_ms(&tree, frames, &mut target);
        eprintln!("{name} {:.4}", (total - baseline).max(0.0));
        std::fs::write(format!("resvg-{name}.rgba"), target.data()).unwrap();
    }
    eprintln!("baseline {baseline:.4}");
}
