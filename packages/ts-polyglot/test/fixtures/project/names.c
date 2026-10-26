#include <stddef.h>
#include <string.h>

// The addon calls this by its own name. (It can't be named like a libc function the glue's headers
// declare, such as random(): glibc's <stdlib.h> comes first and the signatures conflict.)
int shuffle(int x) {
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
