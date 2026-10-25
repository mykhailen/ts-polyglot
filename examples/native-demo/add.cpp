#include <string>

// Both styles work: a function with C linkage, and a plain C++ function with C++ linkage.
extern "C" int add(int a, int b) {
    return a + b;
}

int multiply(int a, int b) {
    return a * b;
}

// A function in a namespace exports under its own name: `import { square }`.
namespace math {
    int square(int a) {
        return a * a;
    }
}

// std::string in and out: a JavaScript string on the other side, UTF-8 in between.
std::string greet(const std::string& name) {
    return "hello, " + name;
}
