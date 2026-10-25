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
