#include <stddef.h>
#include <string.h>

// Named like libc's random(): the addon has to call this one, not libc's.
int random(int x) {
    return x * 2;
}

// A `const char*` result is borrowed: copied into a JavaScript string, never freed; NULL is null.
const char* describe(int n) {
    return n < 0 ? NULL : "non-negative";
}

// A `const char*` argument may be null, and can't carry an embedded NUL.
size_t byte_count(const char* s) {
    return s ? strlen(s) : 0;
}
