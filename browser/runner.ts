import { WebGPUHost } from './host.ts';

/**
 * Runs compiled Silk sample entrypoints and collects their GPU readbacks.
 *
 * **Details**
 *
 * Each sample gets a fresh wasm instance. Event-driven polling never blocks the
 * browser, and completion requires clean GPU handles and no validation errors.
 *
 * @category testing
 */
export async function runSamples(wasmURL, indices = [0, 1, 2, 3, 4, 5], timeout = 30000) {
  const module = await WebAssembly.compileStreaming(fetch(wasmURL));
  const results = [];
  for (const index of indices) {
    const output = new Map();
    const host = new WebGPUHost();
    let instance;
    const imports = {
      webgpu: host.imports,
      host: {
        sample_output(kind, ptr, length) {
          if (output.has(kind)) throw new Error(`Sample ${index} produced duplicate output kind ${kind}`);
          output.set(kind, host.bytes(ptr, length).slice());
        },
      },
    };
    instance = await WebAssembly.instantiate(module, imports);
    host.attach(instance);
    const state = host.call('sample_start', index);
    if (!state) throw new Error(`Silk sample_start(${index}) failed`);
    try {
      const { promise, resolve, reject } = Promise.withResolvers();
      let stopped = false;
      let frame;
      const deadline = setTimeout(() => finish(new Error(`Silk sample ${index} timed out`)), timeout);
      const finish = error => {
        if (stopped) return;
        stopped = true;
        clearTimeout(deadline);
        cancelAnimationFrame(frame);
        host.onWake = undefined;
        error ? reject(error) : resolve();
      };
      const poll = () => {
        if (stopped) return;
        try {
          const status = host.call('sample_poll', state);
          if (status === 1) finish();
          else if (status < 0) finish(new Error(`Silk sample ${index} failed: ${new TextDecoder().decode(output.get(3) ?? new Uint8Array())}`));
          else if (status !== 0) finish(new Error(`Invalid sample_poll status ${status}`));
        } catch (error) { finish(error); }
      };
      const tick = () => { poll(); if (!stopped) frame = requestAnimationFrame(tick); };
      host.onWake = poll;
      tick();
      await promise;
    } finally { host.call('sample_drop', state); }
    // Uncaptured validation errors may arrive as a task after submission resolves.
    const settled = Promise.withResolvers();
    setTimeout(settled.resolve, 0);
    await settled.promise;
    host.assertClean();
    const metadata = output.get(0);
    const rgba = output.get(1);
    const compute = output.get(2);
    if (index === 4 && (!compute || compute.byteLength % 4)) throw new Error('Compute sample must export u32 results');
    if (!metadata || metadata.byteLength !== 8 || !rgba) throw new Error(`Sample ${index} omitted dimensions or pixels`);
    const dimensions = new DataView(metadata.buffer);
    const width = dimensions.getUint32(0, true), height = dimensions.getUint32(4, true);
    if (rgba.byteLength !== width * height * 4) throw new Error(`Sample ${index} RGBA length does not match dimensions`);
    const result = { index, width, height, rgba: Array.from(rgba) };
    if (compute) {
      const view = new DataView(compute.buffer);
      result.compute = Array.from({ length: compute.byteLength / 4 }, (_, i) => view.getUint32(i * 4, true));
    }
    results.push(result);
  }
  return results;
}
