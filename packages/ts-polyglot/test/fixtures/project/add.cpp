extern "C" int add(int a, int b) {
    return a + b;
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
