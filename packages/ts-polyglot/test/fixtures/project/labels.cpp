#include <string>

// A std::string field means the shim converts through a mirror struct.
struct Label { std::string text; int size; };

Label louder(const Label& l) {
    return { l.text + "!", l.size + 1 };
}

// Plain data in a namespace crosses as itself.
namespace ui {
    struct Pt { double x; double y; };

    Pt mid(Pt a, Pt b) {
        return { (a.x + b.x) / 2, (a.y + b.y) / 2 };
    }
}
