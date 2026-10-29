#include "support.h"
#include <stdio.h>
#include <stdlib.h>

static void failed(const char *what) { fprintf(stderr, "benchmark: %s\n", what); exit(1); }
static void adapter_ready(WGPURequestAdapterStatus status, WGPUAdapter adapter, WGPUStringView message, void *a, void *b) {
    (void)message; (void)b; if (status != WGPURequestAdapterStatus_Success) failed("adapter request"); *(WGPUAdapter *)a = adapter;
}
static void device_ready(WGPURequestDeviceStatus status, WGPUDevice device, WGPUStringView message, void *a, void *b) {
    (void)message; (void)b; if (status != WGPURequestDeviceStatus_Success) failed("device request"); *(WGPUDevice *)a = device;
}
static void gpu_error(WGPUDevice const *device, WGPUErrorType type, WGPUStringView message, void *a, void *b) {
    (void)device; (void)type; (void)a; (void)b;
    fprintf(stderr, "WebGPU error: %.*s\n", (int)message.length, message.data); exit(1);
}
static void lost(WGPUDevice const *device, WGPUDeviceLostReason reason, WGPUStringView message, void *a, void *b) {
    (void)device; (void)message; (void)a; (void)b;
    if (reason != WGPUDeviceLostReason_Destroyed && reason != WGPUDeviceLostReason_CallbackCancelled) failed("device lost");
}
static void wait_for(WGPUInstance instance, WGPUFuture future) {
    WGPUFutureWaitInfo info = WGPU_FUTURE_WAIT_INFO_INIT; info.future = future;
    if (wgpuInstanceWaitAny(instance, 1, &info, UINT64_MAX) != WGPUWaitStatus_Success || !info.completed) failed("wait");
}
int main(void) {
    WGPUInstanceFeatureName feature = WGPUInstanceFeatureName_TimedWaitAny;
    WGPUInstanceDescriptor id = WGPU_INSTANCE_DESCRIPTOR_INIT; id.requiredFeatureCount = 1; id.requiredFeatures = &feature;
    WGPUInstance instance = wgpuCreateInstance(&id); if (!instance) failed("instance");
    WGPUAdapter adapter = NULL; WGPURequestAdapterCallbackInfo ai = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    ai.mode = WGPUCallbackMode_WaitAnyOnly; ai.callback = adapter_ready; ai.userdata1 = &adapter;
    WGPURequestAdapterOptions ao = WGPU_REQUEST_ADAPTER_OPTIONS_INIT; ao.featureLevel = WGPUFeatureLevel_Core;
    wait_for(instance, wgpuInstanceRequestAdapter(instance, &ao, ai));
    WGPUDevice device = NULL; WGPURequestDeviceCallbackInfo di = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
    di.mode = WGPUCallbackMode_WaitAnyOnly; di.callback = device_ready; di.userdata1 = &device;
    WGPUDeviceDescriptor dd = WGPU_DEVICE_DESCRIPTOR_INIT;
    dd.uncapturedErrorCallbackInfo.callback = gpu_error;
    dd.deviceLostCallbackInfo.mode = WGPUCallbackMode_AllowProcessEvents; dd.deviceLostCallbackInfo.callback = lost;
    wait_for(instance, wgpuAdapterRequestDevice(adapter, &dd, di));
    BenchFixture *fixture = bench_setup(device);
    WGPUQueue queue = wgpuDeviceGetQueue(device);
    WGPUBuffer buffer = bench_buffer(fixture); WGPUTextureView view = bench_view(fixture);
    WGPURenderPipeline pipeline = bench_pipeline(fixture);
    WGPUBindGroup groups[] = {bench_group(fixture,0),bench_group(fixture,1)};
    WGPURenderPassColorAttachment color = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    color.view = view; color.loadOp = WGPULoadOp_Clear; color.storeOp = WGPUStoreOp_Store; color.clearValue.a = 1;
    WGPURenderPassDescriptor pass_desc = WGPU_RENDER_PASS_DESCRIPTOR_INIT; pass_desc.colorAttachmentCount = 1; pass_desc.colorAttachments = &color;
    const uint8_t bytes[] = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16};
    uint32_t kind = bench_case(), n = bench_count(), frames = bench_frames();
    bench_drain(fixture,instance);
    for (uint32_t frame = 0; frame < frames + 2; ++frame) {
        if (frame >= 2) bench_begin();
        if (kind == 1) {
            for (uint32_t i=0;i<n;++i) wgpuQueueWriteBuffer(queue,buffer,0,bytes,sizeof(bytes));
            wgpuQueueSubmit(queue,0,NULL);
        } else {
            // Match Silk's explicit empty label, not Dawn's distinct absent-label path.
            WGPUCommandEncoderDescriptor encoder_desc = WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
            encoder_desc.label = (WGPUStringView){"", 0};
            WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device,&encoder_desc);
            WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder,&pass_desc);
            wgpuRenderPassEncoderSetPipeline(pass,pipeline);
            wgpuRenderPassEncoderSetBindGroup(pass,0,groups[0],0,NULL);
            if (kind == 0 || kind == 2) {
                for (uint32_t i=0;i<n;++i) {
                    if (kind == 2) wgpuRenderPassEncoderSetBindGroup(pass,0,groups[i%2],0,NULL);
                    wgpuRenderPassEncoderDraw(pass,6,1,0,i%64);
                }
            } else wgpuRenderPassEncoderDraw(pass,6,kind == 3 ? 10000 : 100000,0,0);
            wgpuRenderPassEncoderEnd(pass); wgpuRenderPassEncoderRelease(pass);
            WGPUCommandBufferDescriptor command_desc = WGPU_COMMAND_BUFFER_DESCRIPTOR_INIT;
            command_desc.label = (WGPUStringView){"", 0};
            WGPUCommandBuffer command = wgpuCommandEncoderFinish(encoder,&command_desc); wgpuCommandEncoderRelease(encoder);
            wgpuQueueSubmit(queue,1,&command); wgpuCommandBufferRelease(command);
        }
        if (frame >= 2) bench_end();
        bench_drain(fixture,instance); wgpuInstanceProcessEvents(instance);
    }
    uint64_t checksum = bench_check(fixture,instance); wgpuInstanceProcessEvents(instance);
    bench_report(0,checksum);
    wgpuBindGroupRelease(groups[0]); wgpuBindGroupRelease(groups[1]); wgpuRenderPipelineRelease(pipeline);
    wgpuTextureViewRelease(view); wgpuBufferRelease(buffer); wgpuQueueRelease(queue);
    bench_destroy(fixture); wgpuDeviceRelease(device); wgpuAdapterRelease(adapter); wgpuInstanceRelease(instance);
    return 0;
}
