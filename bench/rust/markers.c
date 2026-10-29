#ifdef BENCH_CALLGRIND
#include <valgrind/callgrind.h>
#endif
void bench_toggle(void) {
#ifdef BENCH_CALLGRIND
    CALLGRIND_TOGGLE_COLLECT;
#endif
}
int bench_has_markers(void) {
#ifdef BENCH_CALLGRIND
    return 1;
#else
    return 0;
#endif
}
