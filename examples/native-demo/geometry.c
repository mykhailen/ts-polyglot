#include <math.h>
#include <stdbool.h>

// `static` keeps a function private to this file, so TypeScript doesn't see it.
static double square(double x) {
    return x * x;
}

double hypotenuse(double a, double b) {
    return sqrt(square(a) + square(b));
}

bool is_right_triangle(double a, double b, double c) {
    return fabs(hypotenuse(a, b) - c) < 1e-9;
}

// A plain struct crosses by value, as an object with the same fields: `distance({ x: 0, y: 0 }, { x: 3, y: 4 })`.
struct Point { double x; double y; };

double distance(struct Point a, struct Point b) {
    return hypotenuse(a.x - b.x, a.y - b.y);
}

// A const array parameter and the integer parameter after it are one `readonly number[]` in
// TypeScript: `mean([1, 2, 3, 4])`. The glue passes the length.
double mean(const double xs[], size_t n) {
    double sum = 0;
    for (size_t i = 0; i < n; i++) sum += xs[i];
    return n ? sum / n : 0;
}
