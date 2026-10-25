// Both styles work: a function with C linkage, and a plain C++ function with C++ linkage.
extern "C" int add(int a, int b) {
    return a + b;
}

int multiply(int a, int b) {
    return a * b;
}
