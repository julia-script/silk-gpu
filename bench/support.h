#pragma once
#include <stdint.h>
#include <webgpu/webgpu.h>

typedef struct BenchFixture BenchFixture;
uint32_t bench_case(void);
uint32_t bench_count(void);
uint32_t bench_frames(void);
void bench_begin(void);
void bench_end(void);
void bench_report(uint32_t language, uint64_t checksum);
BenchFixture *bench_setup(WGPUDevice device);
void bench_destroy(BenchFixture *fixture);
WGPUBuffer bench_buffer(BenchFixture *fixture);
WGPUTextureView bench_view(BenchFixture *fixture);
WGPURenderPipeline bench_pipeline(BenchFixture *fixture);
WGPUBindGroup bench_group(BenchFixture *fixture, uint32_t index);
void bench_drain(BenchFixture *fixture, WGPUInstance instance);
uint64_t bench_check(BenchFixture *fixture, WGPUInstance instance);
