#include <stdexcept>
#include <string>
#include <string_view>

extern "C" int add(int a, int b) {
    return a + b;
}

// An exception escaping into the glue would take node down; the C++ shim turns it into an Error.
int throws(int x) {
    if (x > 0) throw std::runtime_error("boom");
    return x;
}

// ASCII upper-casing only, so non-ASCII bytes pass through untouched.
std::string shout(const std::string& s) {
    std::string r = s;
    for (auto& c : r) if (c >= 'a' && c <= 'z') c -= 32;
    return r + "!";
}

std::string first_word(std::string_view s) {
    return std::string(s.substr(0, s.find(' ')));
}

// Length-carrying strings keep embedded NULs.
std::string repeat(std::string s, int n) {
    std::string r;
    while (n-- > 0) r += s;
    return r;
}

// A parameter named like the shim's own temporary once broke the build.
std::string same(const std::string& r) {
    return r;
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
