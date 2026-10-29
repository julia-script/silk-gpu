#include <webgpu/webgpu.h>

_Static_assert(WGPUFeatureName_ShaderModuleCompilationOptions == 0x0005002e,
               "Update resources.SHADER_MODULE_COMPILATION_OPTIONS for the pinned Dawn ABI");

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

/* Dawn's native extension is deliberately opt-in per shader, not a device-wide math toggle. */
WGPUShaderModule silkWebgpuCreateShaderModuleStrict(WGPUDevice device,
                                                  const WGPUShaderModuleDescriptor *descriptor) {
    WGPUShaderModuleDescriptor strict = *descriptor;
    WGPUShaderModuleCompilationOptions options = WGPU_SHADER_MODULE_COMPILATION_OPTIONS_INIT;
    options.strictMath = WGPU_TRUE;
    options.chain.next = descriptor->nextInChain;
    strict.nextInChain = &options.chain;
    return wgpuDeviceCreateShaderModule(device, &strict);
}
