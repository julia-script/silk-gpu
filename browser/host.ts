// Dependency-free WebGPU host. This TypeScript module deliberately uses only
// ECMAScript syntax, so browsers load it directly without a bundler.
import { schema } from './generated_schema.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const pointee = type => type.replace(/^\?\[\*\](?:const|mut) |^\?\*(?:const|mut) /, '');
const C = schema.constants;

/**
 * Refcounted WebGPU objects addressed by non-recycled integer handles.
 *
 * @category resource management
 */
export class ObjectTable {
  next = 1;
  entries = new Map();
  identities = new WeakMap();
  add(object, type, extra = {}) {
    if (object == null) return 0;
    const old = this.identities.get(object);
    if (old && this.entries.has(old)) { this.entry(old, type).refs++; return old; }
    const id = this.next++;
    if (id > 0xffffffff) throw new RangeError('WebGPU handle space exhausted');
    this.entries.set(id, { object, type, refs: 1, ...extra });
    this.identities.set(object, id);
    return id;
  }
  entry(id, type) {
    const entry = this.entries.get(Number(id));
    if (!entry || (type && entry.type !== type)) throw new TypeError(`Invalid ${type || 'WebGPU'} handle ${id}`);
    return entry;
  }
  get(id, type) { return id === 0 ? undefined : this.entry(id, type).object; }
  retain(id) { this.entry(id).refs++; }
  release(id) {
    const entry = this.entry(id);
    if (--entry.refs === 0) { this.entries.delete(Number(id)); this.identities.delete(entry.object); entry.dispose?.(); }
  }
  get size() { return this.entries.size; }
}

/**
 * WebGPU C-ABI imports backed by the browser's `navigator.gpu`.
 *
 * **Details**
 *
 * ABI: wasm32 C-layout records. Single-scalar records lower to that scalar;
 * other aggregates use indirect arguments and leading sret results. Callback
 * tokens are not WebAssembly function-table indices.
 * The embedding supplies webgpu_alloc/free and the flat webgpu_callback_* exports
 * listed below (strings become data,length pairs, followed by both userdata words).
 * Promise continuations only enqueue; callbacks run inside explicit event pumps.
 *
 * **Gotchas**
 *
 * Browser-native differences follow the [WebGPU specification](https://www.w3.org/TR/webgpu/):
 * - WaitAny accepts timeout zero only; no instance TimedWaitAny feature is exposed.
 * - Browser security redacts numeric PCI IDs/backend identity; adapter.info strings
 *   are retained and backendType is WebGPU, adapterType Unknown.
 * - WGSL is supported; native SPIR-V and OS surface handles are not browser APIs.
 * - Canvas presentation is automatic FIFO; explicit present validates configuration.
 * - Raw mapped pointers need a wasm shadow, aligned congruently with the mapping
 *   offsets modulo 16; writable shadows copy back before unmap. Read/WriteMappedRange
 *   instead copy directly between the browser mapping and caller memory.
 * - Every mapped-range call acquires a fresh browser range; wasm rejects even
 *   const overlaps. Native mapping errors return null/status-error. Only pointer
 *   getters accept WHOLE_MAP_SIZE; mutable access requires a write mapping.
 * - Native-only / not-yet-shipped methods (e.g. encoder.writeTimestamp) fail
 *   explicitly rather than pretending a GPU command was recorded.
 * - Compilation message UTF-16 positions are converted to native UTF-8 offsets.
 * - Final device release cancels callbacks before destroying the browser device,
 *   matching native external-reference ownership. Cancelled device requests also
 *   destroy their unclaimed result, including results settling after cancellation.
 *
 * @category running
 */
export class WebGPUHost {
  table = new ObjectTable();
  exports;
  imports = {};
  pending = new Map();
  events = [];
  nextFuture = 1n;
  depth = 0;
  scheduled = false;
  pumping = false;
  allocations = new Map();
  failures = [];
  canvases = new Map();
  constructor(options = {}) {
    this.gpu = options.gpu ?? globalThis.navigator?.gpu;
    if (!this.gpu) throw new Error('navigator.gpu is unavailable: use a secure context and a WebGPU-enabled browser');
    this.onWake = options.onWake;
    this.onError = options.onError ?? (error => this.failures.push(String(error?.message ?? error)));
    for (const fn of schema.functions) this.imports[fn.name] = (...args) => this.invoke(fn, args);
    this.imports.webgpu_cancel_future = id => this.cancelFuture(id);
    this.imports.webgpu_cancel_device_callbacks = id => this.cancelDeviceCallbacks(id);
    this.imports.webgpu_live_handles = () => this.table.size;
  }
  attach(instance) {
    this.exports = instance.exports ?? instance;
    if (!(this.exports.memory instanceof WebAssembly.Memory)) throw new TypeError('Silk wasm must export memory');
    return this;
  }
  /** Every entry into Silk (including frames) must use call, so wake never reenters a loan. */
  call(name, ...args) {
    const fn = this.exports?.[name];
    if (typeof fn !== 'function') throw new TypeError(`Missing Silk export ${name}`);
    this.depth++;
    try { return fn(...args); }
    finally { this.depth--; }
  }
  scheduleWake() {
    if (this.scheduled || this.depth) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.depth) { this.scheduleWake(); return; }
      // wake does not itself dispatch callbacks; Silk enters its marked pump.
      if (this.exports?.webgpu_wake) this.call('webgpu_wake');
      this.onWake?.();
    });
  }
  view() { return new DataView(this.exports.memory.buffer); }
  bytes(ptr, length) {
    if (!Number.isSafeInteger(ptr) || !Number.isSafeInteger(length) || ptr < 0 || length < 0 || ptr + length > this.exports.memory.buffer.byteLength)
      throw new RangeError('WebGPU memory span is outside wasm memory');
    return new Uint8Array(this.exports.memory.buffer, ptr, length);
  }
  string(ptr, length) {
    if (!ptr) return '';
    if (length === 0xffffffff) {
      const bytes = this.bytes(ptr, this.exports.memory.buffer.byteLength - ptr);
      const end = bytes.indexOf(0);
      if (end < 0) throw new RangeError('Unterminated WGPUStringView');
      return decoder.decode(bytes.subarray(0, end));
    }
    return decoder.decode(this.bytes(ptr, length));
  }
  alloc(size) {
    if (!size) return 0;
    if (!this.exports.webgpu_alloc) throw new TypeError('Silk must export webgpu_alloc(size) for browser-owned result storage');
    const ptr = Number(this.exports.webgpu_alloc(size));
    if (!ptr) throw new RangeError('Silk allocation failed');
    this.bytes(ptr, size).fill(0);
    this.allocations.set(ptr, size);
    return ptr;
  }
  free(ptr) {
    if (!ptr) return;
    const size = this.allocations.get(ptr);
    if (size === undefined) throw new TypeError(`Unknown browser allocation ${ptr}`);
    if (!this.exports.webgpu_free) throw new TypeError('Silk must export webgpu_free(pointer, size)');
    this.allocations.delete(ptr);
    this.exports.webgpu_free(ptr, size);
  }
  size(type) {
    if (type.startsWith('?') || type.endsWith('Callback') || schema.objects[type]) return 4;
    if (schema.layouts[type]) return schema.layouts[type].size;
    if (type === 'u8' || type === 'i8') return 1;
    if (type === 'u16' || type === 'i16') return 2;
    return ['u64', 'i64', 'f64', ...schema.flags].includes(type) ? 8 : 4;
  }
  raw(type, ptr) {
    const view = this.view();
    if (schema.layouts[type]) {
      const value = {};
      for (const field of schema.layouts[type].fields) value[field.name] = this.raw(field.type, ptr + field.offset);
      return value;
    }
    if (type === 'u64' || schema.flags.includes(type)) return view.getBigUint64(ptr, true);
    if (type === 'i64') return view.getBigInt64(ptr, true);
    if (type === 'f64') return view.getFloat64(ptr, true);
    if (type === 'f32') return view.getFloat32(ptr, true);
    if (type === 'i32') return view.getInt32(ptr, true);
    if (type === 'u16') return view.getUint16(ptr, true);
    if (type === 'i16') return view.getInt16(ptr, true);
    if (type === 'u8') return view.getUint8(ptr);
    if (type === 'i8') return view.getInt8(ptr);
    return view.getUint32(ptr, true);
  }
  enum(type, value) {
    const name = schema.enums[type]?.[Number(value)];
    if (name === 'undefined') return undefined;
    if (name === undefined) throw new RangeError(`Unknown ${type} value ${value}`);
    return name;
  }
  enumValue(type, value) {
    for (const [number, name] of Object.entries(schema.enums[type] ?? {})) if (name === value) return Number(number);
    throw new RangeError(`Browser value ${value} has no ${type} representation`);
  }
  decode(type, value) {
    if (type === 'WGPUStringView') return this.string(value.data, value.length);
    if (type === 'WGPUBool') return !!value;
    if (type === 'WGPUOptionalBool') return value === 2 ? undefined : !!value;
    if (type.startsWith('?') && pointee(type) === 'u8') return Number(value);
    if (schema.objects[type]) return this.table.get(Number(value), type);
    if (schema.enums[type]) return this.enum(type, value);
    if (schema.flags.includes(type)) return Number(value);
    if (type === 'u64') return value === 0xffffffffffffffffn ? undefined : this.number(value);
    if (type.startsWith('?')) {
      if (!value) return undefined;
      return this.decode(pointee(type), this.raw(pointee(type), value));
    }
    if (schema.layouts[type]) return this.descriptor(type, value);
    return value;
  }
  number(value) {
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new RangeError('WebGPU integer exceeds JavaScript exact integer range');
    return result;
  }
  descriptor(type, raw) {
    const result = {};
    const fields = schema.layouts[type].fields;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (field.name === 'nextInChain' || field.name === 'chain' || field.name.endsWith('CallbackInfo')) continue;
      if (field.name.endsWith('Count') && fields[i + 1]?.type.startsWith('?[*]')) {
        const next = fields[++i];
        const itemType = pointee(next.type);
        const pointer = raw[next.name];
        result[next.name] = Array.from({ length: raw[field.name] }, (_, index) => this.decode(itemType, this.raw(itemType, pointer + index * this.size(itemType))));
        continue;
      }
      result[field.name] = this.decode(field.type, raw[field.name]);
    }
    // Chains are explicit: never silently discard an implementation extension.
    let chain = raw.nextInChain ?? 0;
    const seen = new Set();
    while (chain) {
      if (seen.has(chain)) throw new TypeError('Cyclic WebGPU descriptor chain');
      seen.add(chain);
      const head = this.raw('WGPUChainedStruct', chain);
      const entry = Object.entries(C).find(([name, value]) => name.startsWith('WGPUSType_') && value === head.sType);
      if (!entry) throw new TypeError(`Unknown chained structure ${head.sType}`);
      const chainType = entry[0].replace('WGPUSType_', 'WGPU');
      if (chainType === 'WGPUShaderSourceSPIRV') throw new TypeError('Browser WebGPU accepts WGSL, not native SPIR-V');
      if (!schema.layouts[chainType]) throw new TypeError(`Unsupported browser extension ${chainType}`);
      Object.assign(result, this.descriptor(chainType, this.raw(chainType, chain)));
      chain = head.next;
    }
    return this.normalize(type, result, raw);
  }
  normalize(type, value, raw) {
    if (type === 'WGPUBindGroupEntry') {
      const { binding, buffer, offset, size, sampler, textureView, externalTexture } = value;
      return { binding, resource: buffer ? { buffer, offset, size } : sampler ?? textureView ?? externalTexture };
    }
    if (type === 'WGPUBindGroupLayoutEntry') {
      for (const [key, discriminator] of [['buffer', 'type'], ['sampler', 'type'], ['texture', 'sampleType'], ['storageTexture', 'access']]) {
        if (raw[key]?.[discriminator] === 0) delete value[key];
      }
      if (value.bindingArraySize) throw new TypeError('Native binding arrays are not exposed by browser WebGPU');
      delete value.bindingArraySize;
    }
    if (type === 'WGPUVertexState' || type === 'WGPUFragmentState' || type === 'WGPUComputeState') {
      if (value.constants) value.constants = Object.fromEntries(value.constants.map(entry => [entry.key, entry.value]));
      if (!value.entryPoint) delete value.entryPoint;
    }
    if (type === 'WGPUComputePipelineDescriptor' || type === 'WGPURenderPipelineDescriptor') value.layout ??= 'auto';
    if (type === 'WGPUVertexBufferLayout' && !raw.attributeCount && !raw.arrayStride && !raw.stepMode) return null;
    if (type === 'WGPURenderPassColorAttachment' && !raw.view) return null;
    if (type === 'WGPUColorTargetState' && !raw.format) return null;
    if (type === 'WGPUExternalTextureBindingLayout') return { externalTexture: {} };
    if (type === 'WGPUTextureComponentSwizzle') return ['r', 'g', 'b', 'a'].map(key => ({ zero: '0', one: '1' }[value[key]] ?? value[key] ?? key)).join('');
    if (type === 'WGPUSurfaceColorManagement') return { colorSpace: value.colorSpace, toneMapping: { mode: value.toneMappingMode } };
    if (type === 'WGPUTextureViewDescriptor') {
      for (const key of ['mipLevelCount', 'arrayLayerCount']) if (raw[key] === 0xffffffff) delete value[key];
    }
    if (type === 'WGPURenderPassColorAttachment' && raw.depthSlice === 0xffffffff) delete value.depthSlice;
    if (type === 'WGPUTexelCopyBufferInfo') {
      Object.assign(value, value.layout);
      delete value.layout;
    }
    if (type === 'WGPUTexelCopyBufferLayout') {
      if (raw.bytesPerRow === 0xffffffff) delete value.bytesPerRow;
      if (raw.rowsPerImage === 0xffffffff) delete value.rowsPerImage;
    }
    if (type === 'WGPULimits') {
      for (const field of schema.layouts[type].fields) if (raw[field.name] === 0xffffffff || raw[field.name] === 0xffffffffffffffffn) delete value[field.name];
    }
    if (type === 'WGPURequestAdapterOptions') {
      if (value.backendType && value.backendType !== 'webgpu') throw new TypeError('Browser adapters do not expose native backend selection');
      delete value.backendType;
      delete value.compatibleSurface;
    }
    return value;
  }
  put(type, ptr, value, owned = []) {
    const view = this.view();
    if (type === 'WGPUStringView') {
      const bytes = encoder.encode(typeof value === 'string' ? value : '');
      const data = this.alloc(bytes.length);
      if (data) { this.bytes(data, bytes.length).set(bytes); owned.push(data); }
      this.view().setUint32(ptr, data, true);
      this.view().setUint32(ptr + 4, bytes.length, true);
      return;
    }
    if (schema.layouts[type]) {
      const fields = schema.layouts[type].fields;
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        if (field.name.endsWith('Count') && fields[i + 1]?.type.startsWith('?[*]')) {
          const next = fields[++i];
          const items = value[next.name] ?? [];
          const itemType = pointee(next.type);
          const data = this.alloc(items.length * this.size(itemType));
          if (data) owned.push(data);
          this.put('usize', ptr + field.offset, items.length, owned);
          this.put(next.type, ptr + next.offset, data, owned);
          items.forEach((item, index) => this.put(itemType, data + index * this.size(itemType), item, owned));
        } else {
          this.put(field.type, ptr + field.offset, value[field.name] ?? 0, owned);
        }
      }
      return;
    }
    if (typeof value === 'string' && schema.enums[type]) value = this.enumValue(type, value);
    if (type === 'u64' || schema.flags.includes(type)) view.setBigUint64(ptr, BigInt(value), true);
    else if (type === 'f64') view.setFloat64(ptr, Number(value), true);
    else if (type === 'f32') view.setFloat32(ptr, Number(value), true);
    else if (type === 'i32') view.setInt32(ptr, Number(value), true);
    else if (type === 'i64') view.setBigInt64(ptr, BigInt(value), true);
    else if (type === 'u16') view.setUint16(ptr, Number(value), true);
    else if (type === 'i16') view.setInt16(ptr, Number(value), true);
    else if (type === 'u8') view.setUint8(ptr, Number(value));
    else if (type === 'i8') view.setInt8(ptr, Number(value));
    else view.setUint32(ptr, Number(value), true);
  }
  output(type, ptr, value) {
    if (!ptr) throw new TypeError(`Null ${type} output pointer`);
    const owned = [];
    this.put(type, ptr, value, owned);
  }
  callbacks = new Map(schema.callbackExports);
  registerCallback(token, callback) {
    if (!Number.isInteger(token) || !token) throw new TypeError('Callback token must be a nonzero u32');
    this.callbacks.set(token, callback);
  }
  callback(info, values) {
    if (!info.callback) return;
    const fn = this.callbacks.get(info.callback);
    if (!fn) throw new TypeError(`Unregistered Silk callback token ${info.callback}`);
    const owned = [];
    const args = [];
    try {
      for (const value of values) {
        if (typeof value === 'string') {
          const bytes = encoder.encode(value);
          const ptr = this.alloc(bytes.length);
          if (ptr) { owned.push(ptr); this.bytes(ptr, bytes.length).set(bytes); }
          args.push(ptr, bytes.length);
        } else if (value && typeof value === 'object' && 'pointerValue' in value) {
          const ptr = this.alloc(4); owned.push(ptr);
          this.put('u32', ptr, value.pointerValue);
          args.push(ptr);
        } else if (value && typeof value === 'object' && 'structType' in value) {
          const ptr = this.alloc(this.size(value.structType)); owned.push(ptr);
          this.put(value.structType, ptr, value.value, owned);
          args.push(ptr);
        } else args.push(value);
      }
      args.push(info.userdata1, info.userdata2);
      if (typeof fn === 'string') this.call(fn, ...args);
      else fn(...args);
    } finally { for (const ptr of owned.reverse()) this.free(ptr); }
  }
  start(info, promise, success, failure, owner = 0, discard) {
    if (info.mode === C.WGPUCallbackMode_AllowSpontaneous)
      throw new TypeError('Spontaneous callbacks violate the Silk deferred-callback loan contract');
    const id = this.nextFuture++;
    const source = this.table.entries.get(owner);
    const instance = source?.type === 'WGPUInstance' ? owner : source?.instance;
    const pending = { id, info: { ...info }, owner, instance, ready: false, result: undefined, success, failure, discard };
    this.pending.set(id, pending);
    Promise.resolve(promise).then(
      value => {
        if (!this.pending.has(id)) { discard?.(value); return; }
        pending.ready = true; pending.result = { ok: true, value }; this.enqueue(pending);
      },
      error => {
        if (!this.pending.has(id)) return;
        pending.ready = true; pending.result = { ok: false, value: error }; this.enqueue(pending);
      },
    );
    return { id };
  }
  enqueue(pending) {
    if (!this.pending.has(pending.id)) return;
    this.events.push(pending);
    this.scheduleWake();
  }
  cancelFuture(id) {
    id = BigInt(id);
    // Removing the retained callback before Drop frees its slot is the barrier.
    // The browser Promise need not be cancellable: its continuation sees absence.
    const pending = this.pending.get(id);
    this.pending.delete(id);
    this.events = this.events.filter(event => event.id !== id);
    if (pending?.result?.ok) pending.discard?.(pending.result.value);
    if (pending) pending.result = undefined;
    pending?.cancel?.();
  }
  cancelDeviceCallbacks(id) {
    for (const pending of this.pending.values()) if (pending.owner === Number(id)) this.cancelFuture(pending.id);
    const entry = this.table.entries.get(Number(id));
    if (entry?.errorListener) {
      entry.object.removeEventListener('uncapturederror', entry.errorListener);
      entry.errorListener = undefined;
    }
  }
  pump(only, instance) {
    if (this.pumping) throw new TypeError('Nested WebGPU callback pump');
    this.pumping = true;
    let completed = 0;
    try {
      const events = this.events;
      this.events = [];
      for (const event of events) {
        if (!this.pending.has(event.id)) continue;
        if (instance !== undefined && event.instance !== undefined && event.instance !== instance) {
          this.events.push(event); continue;
        }
        if (only ? !only.has(event.id) : event.info.mode === C.WGPUCallbackMode_WaitAnyOnly) {
          this.events.push(event); continue;
        }
        this.pending.delete(event.id);
        const values = event.result.ok ? event.success(event.result.value) : event.failure(event.result.value);
        this.callback(event.info, values);
        completed++;
      }
    } finally { this.pumping = false; }
    return completed;
  }
  errorType(error) {
    if (!error) return C.WGPUErrorType_NoError;
    if (error.constructor?.name === 'GPUValidationError') return C.WGPUErrorType_Validation;
    if (error.constructor?.name === 'GPUOutOfMemoryError') return C.WGPUErrorType_OutOfMemory;
    return C.WGPUErrorType_Internal;
  }
  installDevice(device, rawDescriptor, instance, adapterInfo) {
    const id = this.table.add(device, 'WGPUDevice', { instance, adapterInfo });
    const lost = rawDescriptor.deviceLostCallbackInfo;
    const uncaptured = rawDescriptor.uncapturedErrorCallbackInfo;
    const entry = this.table.entry(id);
    entry.lostFuture = this.start(lost ?? { callback: 0, mode: C.WGPUCallbackMode_AllowProcessEvents }, device.lost,
      info => {
        if (info.reason !== 'destroyed') this.onError(new Error(`WebGPU device lost: ${info.message}`));
        return [{ pointerValue: this.table.entries.has(id) ? id : 0 }, this.enumValue('WGPUDeviceLostReason', info.reason === 'destroyed' ? 'destroyed' : 'unknown'), info.message];
      },
      error => [{ pointerValue: id }, C.WGPUDeviceLostReason_Unknown, String(error)], id);
    entry.errorListener = event => {
      this.onError(event.error);
      if (!uncaptured?.callback) return;
      const pending = { id: this.nextFuture++, info: { ...uncaptured }, owner: id, instance, ready: true,
        result: { ok: true, value: event.error },
        success: error => [{ pointerValue: this.table.entries.has(id) ? id : 0 }, this.errorType(error), error.message] };
      this.pending.set(pending.id, pending); this.enqueue(pending);
    };
    device.addEventListener('uncapturederror', entry.errorListener);
    entry.dispose = () => {
      this.cancelDeviceCallbacks(id);
      device.removeEventListener('uncapturederror', entry.errorListener);
      device.destroy();
    };
    return id;
  }
  invoke(fn, incoming) {
    const args = [...incoming];
    const scalarResult = schema.scalarRecords[fn.result];
    const sret = schema.layouts[fn.result] && !scalarResult ? Number(args.shift()) : 0;
    if (args.length !== fn.args.length) throw new TypeError(`${fn.name}: ABI argument count ${args.length}, expected ${fn.args.length}`);
    const raw = {};
    for (let i = 0; i < args.length; i++) {
      const arg = fn.args[i];
      const scalar = schema.scalarRecords[arg.type];
      raw[arg.name] = scalar ? scalar.path.reduceRight((value, field) => ({ [field]: value }), args[i])
        : schema.layouts[arg.type] ? this.raw(arg.type, Number(args[i])) : args[i];
    }
    const result = this.operation(fn, raw);
    if (sret) { this.put(fn.result, sret, result); return; }
    if (scalarResult) return scalarResult.path.reduce((value, field) => value[field], result);
    if (fn.result === 'u64' || schema.flags.includes(fn.result)) return BigInt(result);
    return result;
  }
  operation(fn, raw) {
    const name = fn.name;
    if (name.endsWith('AddRef')) { this.table.retain(Object.values(raw)[0]); return; }
    if (name.endsWith('Release')) { this.table.release(Object.values(raw)[0]); return; }
    if (name.endsWith('FreeMembers')) {
      // FreeMembers receives the owning struct by value; free its pointer fields,
      // not the address of the temporary aggregate argument.
      const release = (type, object) => {
        for (const field of schema.layouts[type].fields) {
          const value = object[field.name];
          if (field.type.startsWith('?') && value && this.allocations.has(value)) this.free(value);
          else if (schema.layouts[field.type]) release(field.type, value);
        }
      };
      release(fn.args[0].type, Object.values(raw)[0]); return;
    }
    if (name === 'wgpuCreateInstance') {
      if (raw.descriptor) {
        const descriptor = this.raw('WGPUInstanceDescriptor', raw.descriptor);
        if (descriptor.nextInChain || descriptor.requiredFeatureCount) return 0;
        if (descriptor.requiredLimits && this.raw('WGPUInstanceLimits', descriptor.requiredLimits).timedWaitAnyMaxCount) return 0;
      }
      return this.table.add({ gpu: this.gpu }, 'WGPUInstance');
    }
    if (name === 'wgpuGetInstanceFeatures') { this.output('WGPUSupportedInstanceFeatures', raw.features, { features: [] }); return; }
    if (name === 'wgpuHasInstanceFeature') return 0;
    if (name === 'wgpuGetInstanceLimits') {
      this.output('WGPUInstanceLimits', raw.limits, { timedWaitAnyMaxCount: 0 });
      return C.WGPUStatus_Success;
    }
    const method = schema.methods[name];
    if (!method) throw new TypeError(`Unknown generated WebGPU function ${name}`);
    const ownerArg = fn.args[0].name;
    const id = Number(raw[ownerArg]);
    const entry = this.table.entry(id, method.owner);
    const object = entry.object;
    const op = method.method;
    if (op === 'processEvents') { this.pump(undefined, id); return; }
    if (op === 'waitAny') {
      if (BigInt(raw.timeoutNS) !== 0n) return C.WGPUWaitStatus_Error;
      const selected = new Set();
      const size = this.size('WGPUFutureWaitInfo');
      for (let i = 0; i < raw.futureCount; i++) selected.add(this.raw('WGPUFutureWaitInfo', raw.futures + i * size).future.id);
      if ([...selected].some(future => future <= 0n || future >= this.nextFuture || (this.pending.get(future)?.instance !== undefined && this.pending.get(future).instance !== id)))
        return C.WGPUWaitStatus_Error;
      const ready = new Set([...selected].filter(future => !this.pending.has(future) || this.pending.get(future).ready));
      this.pump(selected, id);
      for (let i = 0; i < raw.futureCount; i++) {
        const ptr = raw.futures + i * size;
        const value = this.raw('WGPUFutureWaitInfo', ptr);
        this.put('WGPUFutureWaitInfo', ptr, { ...value, completed: ready.has(value.future.id) ? 1 : 0 });
      }
      return ready.size ? C.WGPUWaitStatus_Success : C.WGPUWaitStatus_TimedOut;
    }
    if (op === 'requestAdapter') {
      const options = raw.options ? this.decode('WGPURequestAdapterOptions', this.raw('WGPURequestAdapterOptions', raw.options)) : {};
      return this.start(raw.callbackInfo, this.gpu.requestAdapter(options),
        adapter => adapter ? [C.WGPURequestAdapterStatus_Success, this.table.add(adapter, 'WGPUAdapter', { instance: id }), '']
          : [C.WGPURequestAdapterStatus_Unavailable, 0, 'No matching browser adapter'],
        error => [C.WGPURequestAdapterStatus_Error, 0, String(error)], id);
    }
    if (op === 'requestDevice') {
      const descriptor = raw.descriptor ? this.raw('WGPUDeviceDescriptor', raw.descriptor) : {};
      const decoded = raw.descriptor ? this.decode('WGPUDeviceDescriptor', descriptor) : {};
      return this.start(raw.callbackInfo, object.requestDevice(decoded),
        device => [C.WGPURequestDeviceStatus_Success, this.installDevice(device, descriptor, entry.instance, object.info), ''],
        error => [C.WGPURequestDeviceStatus_Error, 0, String(error)], id, device => device.destroy());
    }
    if (op === 'mapAsync') {
      const offset = Number(raw.offset);
      const size = Number(raw.size) === 0xffffffff ? undefined : Number(raw.size);
      const mapping = object.mapAsync(Number(raw.mode), offset, size).then(() => {
        if (object.mapState === 'mapped') { entry.mapMode = Number(raw.mode); entry.mapOffset = offset; }
      });
      const future = this.start(raw.callbackInfo, mapping,
        () => [C.WGPUMapAsyncStatus_Success, ''],
        error => [C.WGPUMapAsyncStatus_Error, String(error)], id);
      this.pending.get(future.id).cancel = () => this.mappingOperation('unmap', entry, {});
      return future;
    }
    if (op === 'onSubmittedWorkDone') return this.start(raw.callbackInfo, object.onSubmittedWorkDone(),
      () => [C.WGPUQueueWorkDoneStatus_Success, ''], error => [C.WGPUQueueWorkDoneStatus_Error, String(error)], id);
    if (op === 'popErrorScope') return this.start(raw.callbackInfo, object.popErrorScope(),
      error => [C.WGPUPopErrorScopeStatus_Success, this.errorType(error), error?.message ?? ''],
      error => [C.WGPUPopErrorScopeStatus_Error, C.WGPUErrorType_NoError, String(error)], id);
    if (op === 'getCompilationInfo') return this.start(raw.callbackInfo, object.getCompilationInfo(),
      info => [C.WGPUCompilationInfoRequestStatus_Success, { structType: 'WGPUCompilationInfo', value: {
        messages: info.messages.map(message => {
          const source = entry.source ?? '';
          const lineStart = source.lastIndexOf('\n', Math.max(0, message.offset - 1)) + 1;
          return { message: message.message, type: message.type, lineNum: message.lineNum,
            linePos: message.linePos ? encoder.encode(source.slice(lineStart, message.offset)).length + 1 : 0,
            offset: encoder.encode(source.slice(0, message.offset)).length,
            length: encoder.encode(source.slice(message.offset, message.offset + message.length)).length };
        }),
      } }],
      error => { this.onError(error); return [C.WGPUCompilationInfoRequestStatus_CallbackCancelled, 0]; }, id);
    if (op === 'createComputePipelineAsync' || op === 'createRenderPipelineAsync') {
      const type = op === 'createComputePipelineAsync' ? 'WGPUComputePipeline' : 'WGPURenderPipeline';
      const desc = this.decode(type + 'Descriptor', this.raw(type + 'Descriptor', raw.descriptor));
      return this.start(raw.callbackInfo, object[op](desc),
        pipeline => [C.WGPUCreatePipelineAsyncStatus_Success, this.table.add(pipeline, type, { instance: entry.instance }), ''],
        error => [error.reason === 'validation' ? C.WGPUCreatePipelineAsyncStatus_ValidationError : C.WGPUCreatePipelineAsyncStatus_InternalError, 0, String(error)], id);
    }
    if (op === 'getLimits') { this.output('WGPULimits', raw.limits, object.limits); return C.WGPUStatus_Success; }
    if (op === 'getFeatures') {
      const features = [...object.features].flatMap(value => {
        const found = Object.entries(schema.enums.WGPUFeatureName).find(([, name]) => name === value);
        return found ? [Number(found[0])] : [];
      });
      this.output('WGPUSupportedFeatures', raw.features, { features }); return;
    }
    if (op === 'hasFeature') return object.features.has(this.enum('WGPUFeatureName', raw.feature)) ? 1 : 0;
    if (op === 'getWGSLLanguageFeatures' || op === 'hasWGSLLanguageFeature') {
      const features = this.gpu.wgslLanguageFeatures;
      if (op === 'hasWGSLLanguageFeature') return features.has(this.enum('WGPUWGSLLanguageFeatureName', raw.feature)) ? 1 : 0;
      const entries = [...features].flatMap(value => {
        const found = Object.entries(schema.enums.WGPUWGSLLanguageFeatureName).find(([, name]) => name === value);
        return found ? [Number(found[0])] : [];
      });
      this.output('WGPUSupportedWGSLLanguageFeatures', raw.features, { features: entries }); return;
    }
    if (op === 'getInfo' || op === 'getAdapterInfo') {
      const info = object.info ?? object.adapterInfo ?? entry.adapterInfo;
      this.output('WGPUAdapterInfo', raw.info ?? raw.adapterInfo, { vendor: info.vendor, architecture: info.architecture,
        device: info.device, description: info.description, backendType: C.WGPUBackendType_WebGPU,
        adapterType: C.WGPUAdapterType_Unknown, subgroupMinSize: info.subgroupMinSize ?? 0, subgroupMaxSize: info.subgroupMaxSize ?? 0 });
      return C.WGPUStatus_Success;
    }
    if (op === 'getQueue') return this.table.add(object.queue, 'WGPUQueue', { instance: entry.instance });
    if (op === 'getLostFuture') return entry.lostFuture ?? { id: 0n };
    if (op === 'setLabel') { object.label = this.decode('WGPUStringView', raw.label); return; }
    if (method.owner === 'WGPUSurface' || op === 'createSurface') return this.surfaceOperation(op, id, raw);
    if (method.owner === 'WGPUBuffer' && ['getMappedRange', 'getConstMappedRange', 'readMappedRange', 'writeMappedRange', 'unmap', 'destroy'].includes(op))
      return this.mappingOperation(op, entry, raw);
    if (op === 'getTextureBindingViewDimension') return entry.textureBindingViewDimension ?? C.WGPUTextureViewDimension_Undefined;
    if (op.startsWith('get') && fn.args.length === 1) {
      const property = op[3].toLowerCase() + op.slice(4);
      const value = object[property];
      if (value === undefined) throw new TypeError(`Browser does not expose ${method.owner}.${property}`);
      return schema.enums[fn.result] ? this.enumValue(fn.result, value) : value;
    }
    const decoded = [];
    for (let i = 1; i < fn.args.length; i++) {
      const arg = fn.args[i];
      if (arg.name.endsWith('Count') && fn.args[i + 1]?.type.startsWith('?[*]')) {
        const next = fn.args[++i], type = pointee(next.type);
        decoded.push(Array.from({ length: Number(raw[arg.name]) }, (_, n) => this.decode(type, this.raw(type, Number(raw[next.name]) + n * this.size(type)))));
      } else decoded.push(this.decode(arg.type, raw[arg.name]));
    }
    if (op === 'writeBuffer') {
      object.writeBuffer(this.table.get(raw.buffer, 'WGPUBuffer'), this.number(raw.bufferOffset), this.bytes(Number(raw.data), Number(raw.size)));
      return;
    }
    if (op === 'writeTexture') {
      object.writeTexture(decoded[0], this.bytes(Number(raw.data), Number(raw.dataSize)), decoded[3], decoded[4]);
      return;
    }
    if (op === 'setImmediates') {
      if (!object.setImmediates) throw new TypeError('This browser does not expose the WebGPU immediates feature');
      object.setImmediates(Number(raw.offset), this.bytes(Number(raw.data), Number(raw.size)));
      return;
    }
    if (typeof object[op] !== 'function') throw new TypeError(`This browser does not expose ${method.owner}.${op}`);
    const value = object[op](...decoded);
    if (schema.objects[fn.result]) {
      const metadata = { instance: entry.instance };
      if (fn.result === 'WGPUShaderModule') metadata.source = decoded[0].code;
      if (fn.result === 'WGPUTexture') metadata.textureBindingViewDimension = decoded[0].textureBindingViewDimension
        ? this.enumValue('WGPUTextureViewDimension', decoded[0].textureBindingViewDimension) : C.WGPUTextureViewDimension_Undefined;
      if (fn.result === 'WGPUBuffer') {
        const descriptor = this.raw('WGPUBufferDescriptor', raw.descriptor);
        metadata.mapMode = descriptor.mappedAtCreation ? C.WGPUMapMode_Write : 0;
        metadata.mapOffset = 0;
      }
      const handle = this.table.add(value, fn.result, metadata);
      if (fn.result === 'WGPUBuffer') {
        const entry = this.table.entry(handle);
        entry.dispose = () => this.mappingOperation('unmap', entry, {});
      }
      return handle;
    }
    return value;
  }
  mappingOperation(op, entry, raw) {
    const buffer = entry.object;
    entry.ranges ??= [];
    if (op === 'unmap' || op === 'destroy') {
      try {
        if (op === 'unmap' && buffer.mapState === 'mapped') {
          for (const range of entry.ranges) if (range.writable)
            new Uint8Array(range.array).set(this.bytes(range.ptr, range.size));
        }
      } finally {
        for (const range of entry.ranges) if (range.base) this.free(range.base);
        entry.ranges = [];
        entry.mapMode = 0;
        entry.mapOffset = 0;
      }
      buffer[op]();
      return;
    }
    const pointerResult = op === 'getMappedRange' || op === 'getConstMappedRange';
    const failure = pointerResult ? 0 : C.WGPUStatus_Error;
    const writable = op === 'getMappedRange' || op === 'writeMappedRange';
    if (writable && !(entry.mapMode & C.WGPUMapMode_Write)) return failure;
    const offset = Number(raw.offset);
    const wholeSize = Number(raw.size) === 0xffffffff;
    if (!pointerResult && wholeSize) return failure;
    const size = wholeSize ? buffer.size - offset : Number(raw.size);
    let array;
    try {
      // JS enforces mapping bounds/alignment and every overlap, including const
      // and copy ranges. Never reuse an earlier getMappedRange result on wasm.
      array = buffer.getMappedRange(offset, size);
    } catch (error) {
      if (error?.name === 'OperationError' || error instanceof RangeError) return failure;
      throw error;
    }
    const range = { array, size, base: 0, ptr: 0, writable: false };
    entry.ranges.push(range);
    if (!entry.dispose) entry.dispose = () => this.mappingOperation('unmap', entry, {});
    if (op === 'readMappedRange') {
      this.bytes(Number(raw.data), size).set(new Uint8Array(array));
      return C.WGPUStatus_Success;
    }
    if (op === 'writeMappedRange') {
      new Uint8Array(array).set(this.bytes(Number(raw.data), size));
      return C.WGPUStatus_Success;
    }
    // hostAllocate guarantees a 16-byte base. Preserve native's congruence:
    // returned pointer == mapAsync offset + getMappedRange offset (modulo 16).
    const shift = ((entry.mapOffset ?? 0) + offset) % 16;
    range.base = this.alloc(Math.max(1, size) + (shift ? 15 : 0));
    range.ptr = range.base + shift;
    this.bytes(range.ptr, size).set(new Uint8Array(array));
    range.writable = op === 'getMappedRange';
    return range.ptr;
  }
  registerCanvas(selector, canvas) {
    if (!canvas?.getContext) throw new TypeError('Surface must be an HTMLCanvasElement or OffscreenCanvas');
    this.canvases.set(selector, canvas);
  }
  createSurface(instance, selector, byId = false) {
    this.table.entry(Number(instance), 'WGPUInstance');
    const canvas = this.canvases.get(selector) ?? (byId ? globalThis.document?.getElementById(selector) : globalThis.document?.querySelector(selector));
    if (!canvas) throw new TypeError(`No canvas matches ${selector}`);
    const context = canvas.getContext('webgpu');
    if (!context) throw new TypeError('Canvas WebGPU context is unavailable');
    return this.table.add({ canvas, context, configured: false }, 'WGPUSurface');
  }
  surfaceOperation(op, id, raw) {
    if (op === 'createSurface') {
      const descriptor = this.raw('WGPUSurfaceDescriptor', raw.descriptor);
      const chain = descriptor.nextInChain;
      const sourceType = chain ? this.raw('WGPUChainedStruct', chain).sType : 0;
      if (sourceType !== 0x00040000 && sourceType !== 0x00040001)
        throw new TypeError('Browser surfaces require CanvasHTMLSelector (0x00040000) or CanvasHTMLId (0x00040001); native platform handles are not canvases');
      const selector = this.decode('WGPUStringView', this.raw('WGPUStringView', chain + 8));
      const surface = this.createSurface(id, selector, sourceType === 0x00040001);
      this.table.get(surface).label = this.decode('WGPUStringView', descriptor.label);
      return surface;
    }
    const surface = this.table.get(id, 'WGPUSurface');
    if (op === 'configure') {
      const config = this.decode('WGPUSurfaceConfiguration', this.raw('WGPUSurfaceConfiguration', raw.config));
      if (config.presentMode && config.presentMode !== 'fifo') throw new TypeError('Browser canvas presentation is FIFO; other present modes are native-only');
      if (config.alphaMode === 'auto') config.alphaMode = 'opaque';
      if (config.alphaMode === 'inherit') throw new TypeError('Browser canvas does not support inherited composite alpha');
      surface.canvas.width = config.width;
      surface.canvas.height = config.height;
      delete config.width; delete config.height; delete config.presentMode;
      surface.context.configure(config);
      surface.configured = true;
      return;
    }
    if (op === 'unconfigure') { surface.context.unconfigure(); surface.configured = false; return; }
    if (op === 'present') {
      // Canvas textures are presented by the user agent at frame boundaries.
      return surface.configured ? C.WGPUStatus_Success : C.WGPUStatus_Error;
    }
    if (op === 'getCurrentTexture') {
      const texture = surface.context.getCurrentTexture();
      this.output('WGPUSurfaceTexture', raw.surfaceTexture, {
        texture: this.table.add(texture, 'WGPUTexture'), status: C.WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal,
      });
      return;
    }
    if (op === 'getCapabilities') {
      this.table.entry(Number(raw.adapter), 'WGPUAdapter');
      this.output('WGPUSurfaceCapabilities', raw.capabilities, {
        usages: C.WGPUTextureUsage_RenderAttachment | C.WGPUTextureUsage_CopySrc | C.WGPUTextureUsage_CopyDst | C.WGPUTextureUsage_TextureBinding,
        formats: [...new Set([this.gpu.getPreferredCanvasFormat(), 'rgba8unorm', 'bgra8unorm', 'rgba16float'])],
        presentModes: ['fifo'], alphaModes: ['opaque', 'premultiplied'],
      });
      return C.WGPUStatus_Success;
    }
    throw new TypeError(`Unknown surface operation ${op}`);
  }
  assertClean() {
    const problems = [...this.failures];
    if (this.table.size) problems.push(`${this.table.size} live GPU handles`);
    if (this.pending.size) problems.push(`${this.pending.size} retained callbacks`);
    if (this.allocations.size) problems.push(`${this.allocations.size} browser-owned wasm allocations`);
    if (problems.length) throw new Error(problems.join('\n'));
  }
}
