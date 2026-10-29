#import <Cocoa/Cocoa.h>
#import <QuartzCore/CAMetalLayer.h>

// The NSView retains its layer. No extra reference escapes to Silk; the GLFW
// window must outlive every Surface that borrows this CAMetalLayer.
void *silk_gpu_attach_metal_layer(void *native_window) {
    NSWindow *window = (__bridge NSWindow *)native_window;
    NSView *view = window.contentView;
    CAMetalLayer *layer = [CAMetalLayer layer];
    layer.opaque = YES;
    layer.contentsScale = window.backingScaleFactor;
    view.wantsLayer = YES;
    view.layer = layer;
    return (__bridge void *)layer;
}

void silk_gpu_resize_metal_layer(void *native_window, int width, int height) {
    NSWindow *window = (__bridge NSWindow *)native_window;
    CAMetalLayer *layer = (CAMetalLayer *)window.contentView.layer;
    layer.contentsScale = window.backingScaleFactor;
    layer.drawableSize = CGSizeMake(width, height);
}
