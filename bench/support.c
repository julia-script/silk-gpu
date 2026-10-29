#define _POSIX_C_SOURCE 200809L
#include "support.h"
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef BENCH_CALLGRIND
#include <valgrind/callgrind.h>
#endif
#include "rect_shader.h"

struct BenchFixture {
    WGPUDevice device;
    WGPUQueue queue;
    WGPUBuffer storage, writes, readback;
    WGPUTexture texture;
    WGPUTextureView view;
    WGPURenderPipeline pipeline;
    WGPUBindGroup groups[2];
};
static uint64_t started, elapsed;
static void die(const char *message) { fprintf(stderr, "benchmark: %s\n", message); exit(1); }
static uint32_t setting(const char *key, uint32_t fallback, uint32_t maximum) {
    const char *text = getenv(key);
    if (!text) return fallback;
    char *end; unsigned long value = strtoul(text, &end, 10);
    if (!*text || *end || value > maximum) die("invalid benchmark environment setting");
    return (uint32_t)value;
}
uint32_t bench_case(void) { return setting("BENCH_CASE", 0, 4); }
uint32_t bench_count(void) { uint32_t n = setting("BENCH_N", 10000, 1000000); if (n < 64) die("BENCH_N must be >=64"); return n; }
uint32_t bench_frames(void) { uint32_t n = setting("BENCH_FRAMES", 10, 10000); if (!n) die("BENCH_FRAMES must be positive"); return n; }
static uint64_t now(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) die("clock_gettime failed");
    return (uint64_t)t.tv_sec * UINT64_C(1000000000) + t.tv_nsec;
}
void bench_begin(void) {
    started = now();
#ifdef BENCH_CALLGRIND
    CALLGRIND_TOGGLE_COLLECT;
#endif
}
void bench_end(void) {
#ifdef BENCH_CALLGRIND
    CALLGRIND_TOGGLE_COLLECT;
#endif
    elapsed += now() - started;
}
void bench_report(uint32_t language, uint64_t checksum) {
    const char *names[] = {"draws", "writes", "binds", "rects10k", "rects100k"};
    printf("{\"schema\":1,\"language\":\"%s\",\"workload\":\"%s\",\"n\":%u,\"frames\":%u,\"cpu_ns\":%" PRIu64 ",\"checksum\":%" PRIu64 ",\"checked\":true,\"callgrind_markers\":%s}\n",
        language ? "silk" : "c", names[bench_case()], bench_case() == 3 ? 10000 : bench_case() == 4 ? 100000 : bench_count(), bench_frames(), elapsed, checksum,
#ifdef BENCH_CALLGRIND
        "true"
#else
        "false"
#endif
    );
}
static WGPUStringView text(const char *s) { return (WGPUStringView){s, strlen(s)}; }
static WGPUBuffer buffer(WGPUDevice device, uint64_t size, WGPUBufferUsage usage) {
    WGPUBufferDescriptor d = WGPU_BUFFER_DESCRIPTOR_INIT; d.size = size; d.usage = usage;
    WGPUBuffer b = wgpuDeviceCreateBuffer(device, &d); if (!b) die("buffer creation failed"); return b;
}
BenchFixture *bench_setup(WGPUDevice device) {
    BenchFixture *f = calloc(1, sizeof(*f)); if (!f) die("allocation failed");
    f->device = device; wgpuDeviceAddRef(device); f->queue = wgpuDeviceGetQueue(device);
    f->storage = buffer(device, 100000 * 48, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
    float *rects = calloc(100000 * 12, sizeof(float)); if (!rects) die("allocation failed");
    for (uint32_t i = 0; i < 100000; ++i) {
        float *r = rects + i * 12; uint32_t tile = i % 64;
        r[0] = (tile % 8) * 8 + 1; r[1] = (tile / 8) * 8 + 1; r[2] = r[3] = 6;
        r[4] = 1; r[5] = .5f; r[6] = .25f; r[7] = 1; r[8] = 2;
    }
    wgpuQueueWriteBuffer(f->queue, f->storage, 0, rects, 100000 * 48); free(rects);
    f->writes = buffer(device, 16, WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
    f->readback = buffer(device, 64 * 256, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
    WGPUTextureDescriptor td = WGPU_TEXTURE_DESCRIPTOR_INIT;
    td.size = (WGPUExtent3D){64,64,1}; td.format = WGPUTextureFormat_RGBA8Unorm;
    td.dimension = WGPUTextureDimension_2D; td.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
    f->texture = wgpuDeviceCreateTexture(device, &td);
    f->view = wgpuTextureCreateView(f->texture, NULL);
    WGPUShaderSourceWGSL source = WGPU_SHADER_SOURCE_WGSL_INIT; source.code = text(rect_shader);
    WGPUShaderModuleDescriptor sd = WGPU_SHADER_MODULE_DESCRIPTOR_INIT; sd.nextInChain = &source.chain;
    WGPUShaderModule shader = wgpuDeviceCreateShaderModule(device, &sd);
    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT; target.format = WGPUTextureFormat_RGBA8Unorm; target.writeMask = WGPUColorWriteMask_All;
    WGPUFragmentState frag = WGPU_FRAGMENT_STATE_INIT; frag.module = shader; frag.entryPoint = text("fs"); frag.targetCount = 1; frag.targets = &target;
    WGPURenderPipelineDescriptor pd = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    pd.vertex.module = shader; pd.vertex.entryPoint = text("vs"); pd.fragment = &frag;
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    f->pipeline = wgpuDeviceCreateRenderPipeline(device, &pd);
    WGPUBindGroupLayout layout = wgpuRenderPipelineGetBindGroupLayout(f->pipeline, 0);
    WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT; entry.buffer = f->storage; entry.size = 100000 * 48;
    WGPUBindGroupDescriptor gd = WGPU_BIND_GROUP_DESCRIPTOR_INIT; gd.layout = layout; gd.entryCount = 1; gd.entries = &entry;
    for (int i = 0; i < 2; ++i) f->groups[i] = wgpuDeviceCreateBindGroup(device, &gd);
    wgpuBindGroupLayoutRelease(layout); wgpuShaderModuleRelease(shader);
    return f;
}
WGPUBuffer bench_buffer(BenchFixture *f) { wgpuBufferAddRef(f->writes); return f->writes; }
WGPUTextureView bench_view(BenchFixture *f) { wgpuTextureViewAddRef(f->view); return f->view; }
WGPURenderPipeline bench_pipeline(BenchFixture *f) { wgpuRenderPipelineAddRef(f->pipeline); return f->pipeline; }
WGPUBindGroup bench_group(BenchFixture *f, uint32_t i) { if (i > 1) die("group index"); wgpuBindGroupAddRef(f->groups[i]); return f->groups[i]; }
static void done(WGPUQueueWorkDoneStatus status, WGPUStringView message, void *a, void *b) {
    (void)message; (void)b; if (status != WGPUQueueWorkDoneStatus_Success) die("queue completion failed"); *(int *)a = 1;
}
static void wait_for(WGPUInstance instance, WGPUFuture future) {
    WGPUFutureWaitInfo wait = WGPU_FUTURE_WAIT_INFO_INIT; wait.future = future;
    if (wgpuInstanceWaitAny(instance, 1, &wait, UINT64_MAX) != WGPUWaitStatus_Success || !wait.completed) die("GPU wait failed");
}
void bench_drain(BenchFixture *f, WGPUInstance instance) {
    int completed = 0; WGPUQueueWorkDoneCallbackInfo info = WGPU_QUEUE_WORK_DONE_CALLBACK_INFO_INIT;
    info.mode = WGPUCallbackMode_WaitAnyOnly; info.callback = done; info.userdata1 = &completed;
    wait_for(instance, wgpuQueueOnSubmittedWorkDone(f->queue, info)); if (!completed) die("queue callback missing");
}
static void mapped(WGPUMapAsyncStatus status, WGPUStringView message, void *a, void *b) {
    (void)message; (void)b; if (status != WGPUMapAsyncStatus_Success) die("map failed"); *(int *)a = 1;
}
uint64_t bench_check(BenchFixture *f, WGPUInstance instance) {
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(f->device, NULL);
    size_t size = bench_case() == 1 ? 16 : 64 * 256;
    if (bench_case() == 1) wgpuCommandEncoderCopyBufferToBuffer(encoder, f->writes, 0, f->readback, 0, 16);
    else {
        WGPUTexelCopyTextureInfo src = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT; src.texture = f->texture;
        WGPUTexelCopyBufferInfo dst = WGPU_TEXEL_COPY_BUFFER_INFO_INIT; dst.buffer = f->readback; dst.layout.bytesPerRow = 256; dst.layout.rowsPerImage = 64;
        WGPUExtent3D extent = {64,64,1}; wgpuCommandEncoderCopyTextureToBuffer(encoder, &src, &dst, &extent);
    }
    WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, NULL); wgpuQueueSubmit(f->queue, 1, &commands);
    wgpuCommandBufferRelease(commands); wgpuCommandEncoderRelease(encoder);
    int completed = 0; WGPUBufferMapCallbackInfo info = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
    info.mode = WGPUCallbackMode_WaitAnyOnly; info.callback = mapped; info.userdata1 = &completed;
    wait_for(instance, wgpuBufferMapAsync(f->readback, WGPUMapMode_Read, 0, size, info)); if (!completed) die("map callback missing");
    uint8_t pixels[64 * 256]; if (wgpuBufferReadMappedRange(f->readback, 0, pixels, size) != WGPUStatus_Success) die("readback failed");
    wgpuBufferUnmap(f->readback);
    uint64_t checksum = UINT64_C(14695981039346656037);
    for (size_t i = 0; i < size; ++i) {
        uint8_t expected;
        if (bench_case() == 1) expected = (uint8_t)(i + 1);
        else {
            unsigned x = (i / 4) % 64, y = (i / 4) / 64, channel = i % 4;
            float qx = fabsf((float)(x % 8) + .5f - 4) - 1, qy = fabsf((float)(y % 8) + .5f - 4) - 1;
            float dx = fmaxf(qx, 0), dy = fmaxf(qy, 0);
            int inside = sqrtf(dx*dx + dy*dy) + fminf(fmaxf(qx,qy),0) <= 2;
            const uint8_t color[] = {255,128,64,255}; expected = channel == 3 ? 255 : inside ? color[channel] : 0;
        }
        if (abs((int)pixels[i] - expected) > (bench_case() == 1 ? 0 : 1)) die("GPU result differs from independent expected pixels");
        // Canonicalize the allowed one-byte UNORM rounding difference before hashing.
        checksum = (checksum ^ expected) * UINT64_C(1099511628211);
    }
    return checksum;
}
void bench_destroy(BenchFixture *f) {
    for (int i=0;i<2;++i) wgpuBindGroupRelease(f->groups[i]);
    wgpuRenderPipelineRelease(f->pipeline); wgpuTextureViewRelease(f->view); wgpuTextureRelease(f->texture);
    wgpuBufferRelease(f->readback); wgpuBufferRelease(f->writes); wgpuBufferRelease(f->storage);
    wgpuQueueRelease(f->queue); wgpuDeviceRelease(f->device); free(f);
}
