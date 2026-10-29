use std::{borrow::Cow, time::Instant};
extern "C" { fn bench_toggle(); fn bench_has_markers() -> i32; }
fn setting(name: &str, default: u32, min: u32, max: u32) -> u32 {
    let value = std::env::var(name).map(|v| v.parse::<u32>().expect("integer benchmark setting")).unwrap_or(default);
    assert!((min..=max).contains(&value), "invalid {name}"); value
}
fn drain(device: &wgpu::Device) {
    device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("GPU completion");
}
fn main() { pollster::block_on(run()); }
async fn run() {
    let kind = setting("BENCH_CASE", 0, 0, 4);
    let n = setting("BENCH_N", 10000, 64, 1000000);
    let frames = setting("BENCH_FRAMES", 10, 1, 10000);
    let mut instance_desc = wgpu::InstanceDescriptor::new_without_display_handle();
    instance_desc.flags |= wgpu::InstanceFlags::VALIDATION;
    let instance = wgpu::Instance::new(instance_desc);
    let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions::default()).await.expect("adapter");
    let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor::default()).await.expect("device");
    device.set_device_lost_callback(|reason, message| {
        if reason != wgpu::DeviceLostReason::Destroyed { eprintln!("device lost: {message}"); std::process::exit(1); }
    });
    let storage = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 100000 * 48,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let mut rects = Vec::with_capacity(100000 * 48);
    for i in 0..100000 {
        let tile = i % 64;
        let values: [f32; 12] = [((tile % 8) * 8 + 1) as f32, ((tile / 8) * 8 + 1) as f32,
            6.,6.,1.,0.5,0.25,1.,2.,0.,0.,0.];
        for value in values { rects.extend_from_slice(&value.to_le_bytes()); }
    }
    queue.write_buffer(&storage, 0, &rects);
    let writes = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let readback = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 64 * 256,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let extent = wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 };
    let texture = device.create_texture(&wgpu::TextureDescriptor { label: None, size: extent,
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[] });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None,
        source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(include_str!("../../../examples/shaders/instanced-rects.wgsl"))) });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor { label: None, layout: None,
        vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some("fs"), compilation_options: Default::default(),
            targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())] }),
        primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None });
    let layout = pipeline.get_bind_group_layout(0);
    let groups = std::array::from_fn::<_,2,_>(|_| device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None, layout: &layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: storage.as_entire_binding() }] }));
    let colors = [Some(wgpu::RenderPassColorAttachment { view: &view, depth_slice: None, resolve_target: None,
        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })];
    let pass_desc = wgpu::RenderPassDescriptor { label: None, color_attachments: &colors, depth_stencil_attachment: None,
        timestamp_writes: None, occlusion_query_set: None, multiview_mask: None };
    let bytes: [u8;16] = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
    queue.submit([]); drain(&device);
    let mut elapsed = 0;
    for frame in 0..frames+2 {
        let start = Instant::now();
        if frame >= 2 { unsafe { bench_toggle(); } }
        if kind == 1 {
            for _ in 0..n { queue.write_buffer(&writes,0,&bytes); }
            queue.submit([]);
        } else {
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("") });
            {
                let mut pass = encoder.begin_render_pass(&pass_desc);
                pass.set_pipeline(&pipeline); pass.set_bind_group(0,&groups[0],&[]);
                if kind == 0 || kind == 2 {
                    for i in 0..n {
                        if kind == 2 { pass.set_bind_group(0,&groups[(i%2) as usize],&[]); }
                        pass.draw(0..6,i%64..i%64+1);
                    }
                } else { pass.draw(0..6,0..if kind == 3 { 10000 } else { 100000 }); }
            }
            queue.submit([encoder.finish()]);
        }
        if frame >= 2 { unsafe { bench_toggle(); } elapsed += start.elapsed().as_nanos(); }
        drain(&device);
    }
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    let size = if kind == 1 { 16 } else { 64 * 256 };
    if kind == 1 { encoder.copy_buffer_to_buffer(&writes,0,&readback,0,16); }
    else { encoder.copy_texture_to_buffer(texture.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &readback,
        layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(256), rows_per_image: Some(64) } }, extent); }
    queue.submit([encoder.finish()]);
    let slice = readback.slice(0..size);
    let (tx,rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| { tx.send(result).unwrap(); });
    drain(&device); rx.recv().unwrap().expect("readback map");
    let pixels = slice.get_mapped_range().expect("mapped readback range");
    let mut checksum = 14695981039346656037u64;
    for (i, actual) in pixels.iter().enumerate() {
        let expected = if kind == 1 { (i+1) as u8 } else {
            let x = (i/4)%64; let y = (i/4)/64; let channel = i%4;
            let qx = ((x%8) as f32 + 0.5 - 4.).abs() - 1.;
            let qy = ((y%8) as f32 + 0.5 - 4.).abs() - 1.;
            let inside = (qx.max(0.).powi(2)+qy.max(0.).powi(2)).sqrt()+qx.max(qy).min(0.) <= 2.;
            if channel == 3 { 255 } else if inside { [255,128,64,255][channel] } else { 0 }
        };
        assert!(actual.abs_diff(expected) <= if kind == 1 { 0 } else { 1 }, "GPU result differs at byte {i}");
        checksum = (checksum ^ expected as u64).wrapping_mul(1099511628211);
    }
    drop(pixels); readback.unmap();
    let name = ["draws","writes","binds","rects10k","rects100k"][kind as usize];
    let count = if kind == 3 { 10000 } else if kind == 4 { 100000 } else { n };
    println!("{{\"schema\":1,\"language\":\"rust\",\"workload\":\"{name}\",\"n\":{count},\"frames\":{frames},\"cpu_ns\":{elapsed},\"checksum\":{checksum},\"checked\":true,\"callgrind_markers\":{}}}", unsafe { bench_has_markers() != 0 });
}
