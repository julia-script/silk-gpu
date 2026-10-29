#include <webgpu/webgpu.h>

/* LIMITATION-4: Silk requires one callback invocation mode per declaration. */
void silkWebgpuRegisterError(WGPUDeviceDescriptor *descriptor,
                            WGPUUncapturedErrorCallback callback) {
    descriptor->uncapturedErrorCallbackInfo.callback = callback;
}

WGPUFuture silkWebgpuRequestDevice(WGPUAdapter adapter,
                                  WGPUDeviceDescriptor *descriptor,
                                  WGPUDeviceLostCallback lostCallback,
                                  WGPURequestDeviceCallbackInfo callbackInfo) {
    descriptor->deviceLostCallbackInfo.callback = lostCallback;
    return wgpuAdapterRequestDevice(adapter, descriptor, callbackInfo);
}
