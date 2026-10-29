import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectTable, WebGPUHost } from './host.ts';
import { schema } from './generated_schema.ts';

function fixture() {
  const memory = new WebAssembly.Memory({ initial: 2 });
  let bump = 1024;
  const freed = [];
  const host = new WebGPUHost({ gpu: {} });
  host.attach({ memory,
    webgpu_alloc(size) { const ptr = bump; bump = (bump + size + 15) & ~15; return ptr; },
    webgpu_free(ptr, size) { freed.push([ptr, size]); },
  });
  return { host, memory, freed };
}

test('handles retain identity, reject type confusion and never recycle stale IDs', () => {
  const table = new ObjectTable();
  const object = {};
  const first = table.add(object, 'WGPUBuffer');
  assert.equal(table.add(object, 'WGPUBuffer'), first);
  table.release(first);
  assert.equal(table.get(first), object);
  assert.throws(() => table.get(first, 'WGPUTexture'), /Invalid/);
  table.release(first);
  assert.throws(() => table.get(first), /Invalid/);
  assert.ok(table.add(object, 'WGPUBuffer') > first);
});

test('generated C records decode WGSL, strings and 64-bit descriptor fields after memory growth', () => {
  const { host, memory } = fixture();
  const descriptor = host.alloc(host.size('WGPUBufferDescriptor'));
  host.put('WGPUBufferDescriptor', descriptor, { label: 'résultat', size: 4096n, usage: 9n, mappedAtCreation: 1 });
  memory.grow(1);
  const value = host.decode('WGPUBufferDescriptor', host.raw('WGPUBufferDescriptor', descriptor));
  assert.equal(value.label, 'résultat');
  assert.equal(value.size, 4096);
  assert.equal(value.usage, 9);
  assert.equal(value.mappedAtCreation, true);
  assert.equal(host.enum('WGPUTextureFormat', schema.constants.WGPUTextureFormat_RGBA8Unorm), 'rgba8unorm');
  assert.equal(host.enum('WGPUTextureFormat', schema.constants.WGPUTextureFormat_BC1RGBAUnormSrgb), 'bc1-rgba-unorm-srgb');
});

test('single-field future returns are scalar and u16 fields do not read or overwrite adjacent padding', () => {
  const { host } = fixture();
  assert.deepEqual(schema.scalarRecords.WGPUFuture, { path: ['id'], type: 'u64' });
  const device = host.table.add({}, 'WGPUDevice', { lostFuture: { id: 23n } });
  assert.equal(host.imports.wgpuDeviceGetLostFuture(device), 23n);
  const sampler = host.alloc(host.size('WGPUSamplerDescriptor'));
  host.bytes(sampler, host.size('WGPUSamplerDescriptor')).fill(255);
  const field = schema.layouts.WGPUSamplerDescriptor.fields.find(field => field.name === 'maxAnisotropy');
  host.put(field.type, sampler + field.offset, 1);
  assert.equal(host.raw('WGPUSamplerDescriptor', sampler).maxAnisotropy, 1);
  assert.equal(host.bytes(sampler + field.offset + 2, 1)[0], 255);
  assert.equal(host.size(field.type), 2);
  host.free(sampler);
  host.table.release(device);
  host.assertClean();
});

test('promise completion never calls Silk until a marked pump; cancellation prevents writes into freed slots', async () => {
  const { host } = fixture();
  const calls = [];
  host.registerCallback(99, (...args) => calls.push(args));
  const info = { mode: schema.constants.WGPUCallbackMode_AllowProcessEvents, callback: 99, userdata1: 17, userdata2: 18 };
  const future = host.start(info, Promise.resolve(42), value => [value, 'ready'], error => [0, String(error)]);
  await Promise.resolve();
  assert.equal(calls.length, 0);
  host.pump();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 42);
  assert.deepEqual(calls[0].slice(-2), [17, 18]);
  assert.equal(host.allocations.size, 0);
  const cancelled = host.start(info, Promise.resolve(1), value => [value], () => [0]);
  host.cancelFuture(cancelled.id);
  await Promise.resolve();
  host.pump();
  assert.equal(calls.length, 1);
  assert.equal(host.pending.size, 0);
  assert.ok(future.id < cancelled.id);
});

test('WaitAnyOnly callbacks are selected by zero-timeout WaitAny, not ProcessEvents', async () => {
  const { host } = fixture();
  const calls = [];
  host.registerCallback(99, value => calls.push(value));
  const future = host.start({ mode: schema.constants.WGPUCallbackMode_WaitAnyOnly, callback: 99, userdata1: 0, userdata2: 0 }, Promise.resolve(7), value => [value], () => [0]);
  await Promise.resolve();
  host.pump();
  assert.deepEqual(calls, []);
  const instance = host.imports.wgpuCreateInstance(0);
  const wait = host.alloc(host.size('WGPUFutureWaitInfo'));
  host.put('WGPUFutureWaitInfo', wait, { future, completed: 0 });
  assert.equal(host.imports.wgpuInstanceWaitAny(instance, 1, wait, 1n), schema.constants.WGPUWaitStatus_Error);
  assert.equal(host.imports.wgpuInstanceWaitAny(instance, 1, wait, 0n), schema.constants.WGPUWaitStatus_Success);
  assert.equal(host.raw('WGPUFutureWaitInfo', wait).completed, 1);
  assert.deepEqual(calls, [7]);
  host.imports.wgpuInstanceRelease(instance);
  host.free(wait);
  host.assertClean();
});

test('mapped imports enforce modes, overlaps and sentinels without copy-operation shadow allocations', () => {
  const { host, freed } = fixture();
  const ranges = [];
  let calls = 0;
  const buffer = {
    size: 64, mapState: 'mapped',
    getMappedRange(offset, size) {
      calls++;
      if (this.mapState !== 'mapped' || offset % 8 || size % 4 || offset < 0 || offset + size > this.size ||
          ranges.some(range => offset < range.offset + range.size && range.offset < offset + size))
        throw new DOMException('Invalid mapped range', 'OperationError');
      const array = new ArrayBuffer(size);
      new Uint8Array(array).fill(42);
      ranges.push({ offset, size, array });
      return array;
    },
    unmap() { this.mapState = 'unmapped'; ranges.length = 0; },
  };
  const handle = host.table.add(buffer, 'WGPUBuffer', { mapMode: schema.constants.WGPUMapMode_Read, mapOffset: 0 });
  const destination = host.alloc(16);
  const allocations = host.allocations.size;
  assert.equal(host.imports.wgpuBufferGetMappedRange(handle, 0, 8), 0);
  assert.equal(host.imports.wgpuBufferWriteMappedRange(handle, 0, destination, 8), schema.constants.WGPUStatus_Error);
  assert.equal(calls, 0);
  assert.equal(host.imports.wgpuBufferReadMappedRange(handle, 0, destination, 8), schema.constants.WGPUStatus_Success);
  assert.deepEqual([...host.bytes(destination, 8)], Array(8).fill(42));
  assert.equal(host.allocations.size, allocations);
  assert.equal(host.imports.wgpuBufferGetConstMappedRange(handle, 0, 8), 0);
  assert.equal(host.imports.wgpuBufferReadMappedRange(handle, 0, destination, 8), schema.constants.WGPUStatus_Error);
  assert.equal(calls, 3);
  assert.equal(host.imports.wgpuBufferReadMappedRange(handle, 8, destination, 0xffffffff), schema.constants.WGPUStatus_Error);
  assert.equal(calls, 3);
  assert.equal(host.imports.wgpuBufferGetConstMappedRange(handle, 3, 8), 0);
  const remaining = host.imports.wgpuBufferGetConstMappedRange(handle, 8, 0xffffffff);
  assert.equal(remaining % 16, 8);
  assert.equal(host.imports.wgpuBufferGetConstMappedRange(handle, 8, 4), 0);
  host.imports.wgpuBufferUnmap(handle);
  assert.equal(host.allocations.size, allocations);
  assert.equal(host.imports.wgpuBufferGetConstMappedRange(handle, 0, 8), 0);
  host.imports.wgpuBufferRelease(handle);
  host.free(destination);
  assert.equal(new Set(freed.map(([ptr]) => ptr)).size, freed.length);
  host.assertClean();
});

test('mapped write imports copy directly; pointer ranges preserve alignment and commit once on release', () => {
  const { host, freed } = fixture();
  const arrays = [];
  let unmapped = 0;
  const buffer = {
    size: 64, mapState: 'mapped',
    getMappedRange(offset, size) { const array = new ArrayBuffer(size); arrays.push(array); return array; },
    unmap() { this.mapState = 'unmapped'; unmapped++; },
  };
  const handle = host.table.add(buffer, 'WGPUBuffer', { mapMode: schema.constants.WGPUMapMode_Write, mapOffset: 8 });
  const source = host.alloc(8);
  host.bytes(source, 8).fill(37);
  assert.equal(host.imports.wgpuBufferWriteMappedRange(handle, 8, source, 8), schema.constants.WGPUStatus_Success);
  assert.deepEqual([...new Uint8Array(arrays[0])], Array(8).fill(37));
  assert.equal(host.allocations.size, 1);
  const aligned = host.imports.wgpuBufferGetMappedRange(handle, 24, 8);
  const shifted = host.imports.wgpuBufferGetMappedRange(handle, 32, 8);
  assert.equal(aligned % 16, (8 + 24) % 16);
  assert.equal(shifted % 16, (8 + 32) % 16);
  host.bytes(aligned, 8).fill(51);
  host.bytes(shifted, 8).fill(68);
  host.imports.wgpuBufferRelease(handle);
  assert.equal(unmapped, 1);
  assert.deepEqual([...new Uint8Array(arrays[1])], Array(8).fill(51));
  assert.deepEqual([...new Uint8Array(arrays[2])], Array(8).fill(68));
  host.free(source);
  assert.equal(new Set(freed.map(([ptr]) => ptr)).size, freed.length);
  host.assertClean();
});

test('mapped imports translate only native range failures and release shadows on destroy', () => {
  const { host } = fixture();
  let error = new RangeError('Native range overflow');
  const buffer = {
    size: 16, mapState: 'mapped',
    getMappedRange() { if (error) throw error; return new ArrayBuffer(8); },
    destroy() { this.mapState = 'unmapped'; },
    unmap() { this.mapState = 'unmapped'; },
  };
  const handle = host.table.add(buffer, 'WGPUBuffer', { mapMode: schema.constants.WGPUMapMode_Write, mapOffset: 0 });
  assert.equal(host.imports.wgpuBufferGetMappedRange(handle, 0, 8), 0);
  assert.equal(host.imports.wgpuBufferWriteMappedRange(handle, 0, 0, 8), schema.constants.WGPUStatus_Error);
  assert.equal(host.imports.wgpuBufferWriteMappedRange(handle, 0, 0, 0xffffffff), schema.constants.WGPUStatus_Error);
  error = new TypeError('Unexpected host bug');
  assert.throws(() => host.imports.wgpuBufferGetMappedRange(handle, 0, 8), /Unexpected host bug/);
  error = null;
  assert.notEqual(host.imports.wgpuBufferGetMappedRange(handle, 0, 8), 0);
  host.imports.wgpuBufferDestroy(handle);
  host.imports.wgpuBufferRelease(handle);
  host.assertClean();
});

test('cancelled requestDevice destroys its result exactly once before or after promise settlement without a callback', async () => {
  for (const cancelBeforeSettlement of [true, false]) {
    const { host } = fixture();
    const requested = Promise.withResolvers();
    let destroyed = 0, callbacks = 0;
    const device = { destroy() { destroyed++; } };
    const adapter = host.table.add({ requestDevice() { return requested.promise; } }, 'WGPUAdapter');
    const info = host.alloc(host.size('WGPURequestDeviceCallbackInfo'));
    host.put('WGPURequestDeviceCallbackInfo', info, {
      mode: schema.constants.WGPUCallbackMode_AllowProcessEvents, callback: 99, userdata1: 17, userdata2: 18,
    });
    host.registerCallback(99, () => callbacks++);
    const future = host.imports.wgpuAdapterRequestDevice(adapter, 0, info);
    if (cancelBeforeSettlement) host.imports.webgpu_cancel_future(future);
    requested.resolve(device);
    await Promise.resolve();
    if (!cancelBeforeSettlement) host.imports.webgpu_cancel_future(future);
    host.imports.webgpu_cancel_future(future);
    host.pump();
    assert.equal(destroyed, 1);
    assert.equal(callbacks, 0);
    host.imports.wgpuAdapterRelease(adapter);
    host.free(info);
    host.assertClean();
  }
});

test('duplicated device references destroy only on final release and cancel the lost callback before destruction', async () => {
  const { host } = fixture();
  const lost = Promise.withResolvers();
  let destroyed = 0, callbacks = 0;
  const device = new EventTarget();
  device.lost = lost.promise;
  device.destroy = () => {
    destroyed++;
    lost.resolve({ reason: 'destroyed', message: 'Device released' });
  };
  host.registerCallback(99, () => callbacks++);
  const handle = host.installDevice(device, {
    deviceLostCallbackInfo: { mode: schema.constants.WGPUCallbackMode_AllowProcessEvents, callback: 99, userdata1: 17, userdata2: 18 },
    uncapturedErrorCallbackInfo: { callback: 99, userdata1: 17, userdata2: 18 },
  });
  host.imports.wgpuDeviceAddRef(handle);
  host.imports.wgpuDeviceRelease(handle);
  assert.equal(destroyed, 0);
  assert.equal(host.table.entry(handle).refs, 1);
  host.imports.wgpuDeviceRelease(handle);
  assert.equal(destroyed, 1);
  await Promise.resolve();
  host.pump();
  assert.equal(callbacks, 0);
  host.assertClean();
});
