import { WebGPUHost } from './host.ts';
import { schema } from './generated_schema.ts';

// Playwright serializes Error.message/stack, but not AggregateError.errors.
// Keep all nested diagnostics in the thrown message at the browser boundary.
function describeError(error, seen = new Set()) {
  if (error === null || typeof error !== 'object') return String(error);
  if (seen.has(error)) return '[circular error cause]';
  seen.add(error);
  const details = [error.stack ?? `${error.name ?? 'Error'}: ${error.message ?? String(error)}`];
  if (error.cause !== undefined) details.push(`Caused by:\n${describeError(error.cause, seen)}`);
  if (error instanceof AggregateError)
    for (const [index, nested] of [...error.errors].entries()) details.push(`Aggregate member ${index + 1}:\n${describeError(nested, seen)}`);
  return details.join('\n');
}

// Test-only helper. The caller owns the returned cleanup operation so Playwright
// can screenshot the real last-presented canvas before unconfiguration/teardown.
export async function runCanvas(wasmBytes, timeout = 30000) {
  if (document.getElementById('gpu-test')) throw new Error('Canvas test requires an unused #gpu-test id');
  const canvas = document.createElement('canvas');
  canvas.id = 'gpu-test';
  canvas.style.display = 'block';
  document.body.append(canvas);
  const errors = [];
  const host = new WebGPUHost();
  // Preserve the browser's scoped validation message before Silk turns the
  // failed Result into the sample's status code. Always deliver the real callback.
  const scopeCallback = host.callbacks.get(4);
  host.registerCallback(4, (status, type, data, length, userdata1, userdata2) => {
    if (status !== schema.constants.WGPUPopErrorScopeStatus_Success || type !== schema.constants.WGPUErrorType_NoError)
      errors.push(`Canvas error scope (status ${status}, type ${type}): ${host.string(data, length)}`);
    host.call(scopeCallback, status, type, data, length, userdata1, userdata2);
  });
  let token = 0;
  let instance;
  let closed = false;
  const failure = () => [...errors, ...host.failures].join('\n') || 'compiled Silk canvas operation failed';
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    try {
      if (token) {
        const result = host.call('canvas_drop', token);
        token = 0;
        if (result !== 0) throw new Error(failure());
      }
      // Browser uncaptured-error tasks can be delivered after queue completion.
      const settled = Promise.withResolvers();
      setTimeout(settled.resolve, 0);
      await settled.promise;
      if (errors.length) throw new Error(failure());
      host.assertClean();
    } finally {
      canvas.remove();
    }
  };
  try {
    const bytes = Array.isArray(wasmBytes) ? new Uint8Array(wasmBytes) : wasmBytes;
    const module = await WebAssembly.compile(bytes);
    instance = await WebAssembly.instantiate(module, {
      webgpu: host.imports,
      host: {
        sample_output(kind, pointer, length) {
          if (kind !== 3) throw new Error(`Unexpected canvas output kind ${kind}`);
          errors.push(new TextDecoder().decode(host.bytes(pointer, length)));
        },
      },
    });
    host.attach(instance);
    token = host.call('canvas_start');
    if (!token) throw new Error(failure());
    const frames = [];
    for (const [width, height] of [[64, 64], [96, 48]]) {
      canvas.width = width;
      canvas.height = height;
      const completion = Promise.withResolvers();
      let stopped = false;
      let frame;
      const deadline = setTimeout(() => finish(new Error(`Canvas ${width}x${height} timed out`)), timeout);
      const finish = error => {
        if (stopped) return;
        stopped = true;
        clearTimeout(deadline);
        cancelAnimationFrame(frame);
        error ? completion.reject(error) : completion.resolve();
      };
      const tick = () => {
        if (stopped) return;
        try {
          const status = host.call('canvas_poll', token, width, height);
          if (errors.length || status < 0) finish(new Error(failure()));
          else if (status === 1) finish();
          else if (status !== 0) finish(new Error(`Invalid canvas_poll status ${status}`));
          else frame = requestAnimationFrame(tick);
        } catch (error) { finish(error); }
      };
      frame = requestAnimationFrame(tick);
      await completion.promise;
      if (canvas.width !== width || canvas.height !== height) throw new Error('Surface configuration changed the requested dimensions');
      frames.push({ width, height });
    }
    // Let the browser compositor consume the final GPU presentation. No JS GPU
    // render commands participate: all encoding/configuration lives in Silk.
    const presented = Promise.withResolvers();
    requestAnimationFrame(() => requestAnimationFrame(presented.resolve));
    await presented.promise;
    return { canvas, frames, expectedRGBA: [64, 128, 191, 255], cleanup };
  } catch (error) {
    try { await cleanup(); }
    catch (cleanupError) {
      const aggregate = new AggregateError([error, cleanupError], 'Canvas test and cleanup failed');
      throw new Error(describeError(aggregate), { cause: aggregate });
    }
    throw error;
  }
}
