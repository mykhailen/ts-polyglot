#include <stdexcept>

extern "C" int add(int a, int b) {
    return a + b;
}

// An exception escaping into the glue would take node down; the C++ shim turns it into an Error.
int throws(int x) {
    if (x > 0) throw std::runtime_error("boom");
    return x;
}

int multiply(int a, int b) {
    return a * b;
}

// Inside a namespace: exported as `scale`, called as `geometry::scale` by the glue.
namespace geometry {
    int scale(int a, int factor) {
        return a * factor;
    }
}
