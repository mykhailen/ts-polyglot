#include <stdint.h>

struct Point { int x; int y; };
typedef struct { struct Point min; struct Point max; int64_t id; } Box;
typedef struct { const char* name; int id; } Tag;

int area(struct Point p) {
    return p.x * p.y;
}

Box grow(Box b, int by) {
    b.min.x -= by;
    b.min.y -= by;
    b.max.x += by;
    b.max.y += by;
    return b;
}

// Returns the caller's own string: the glue must make the result before it frees the arguments.
Tag retag(Tag t, int id) {
    t.id = id;
    return t;
}
