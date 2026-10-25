#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// `long` is 64-bit on Linux and macOS, so values past 2^31 must survive the round trip there; on
// Windows it's 32-bit, and the same call is a RangeError.
long echo_long(long x) { return x; }
int8_t echo_i8(int8_t x) { return x; }
uint64_t echo_u64(uint64_t x) { return x; }
size_t count(size_t n) { return n; }
float half(float x) { return x / 2; }
bool negate(bool b) { return !b; }
