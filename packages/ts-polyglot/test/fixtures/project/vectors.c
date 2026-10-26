#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define POLY_NAME_MAX 16

struct Point { int x; int y; };
struct Poly { struct Point pts[4]; char name[POLY_NAME_MAX]; unsigned char key[4]; int grid[2][2]; };

double mean(const double xs[], size_t n) {
    double s = 0;
    for (size_t i = 0; i < n; i++) s += xs[i];
    return n ? s / n : 0;
}

double dot(const double a[], const double b[], int n) {
    double s = 0;
    for (int i = 0; i < n; i++) s += a[i] * b[i];
    return s;
}

uint32_t checksum(const unsigned char data[], size_t len) {
    uint32_t s = 0;
    for (size_t i = 0; i < len; i++) s = s * 31 + data[i];
    return s;
}

const char* longest(const char* const names[], int n) {
    const char* best = NULL;
    for (int i = 0; i < n; i++) if (names[i] && (!best || strlen(names[i]) > strlen(best))) best = names[i];
    return best;
}

/* A counted string: a NUL inside is just a byte. */
size_t count_a(const char s[], size_t n) {
    size_t c = 0;
    for (size_t i = 0; i < n; i++) if (s[i] == 'a') c++;
    return c;
}

float norm(const float v[3]) {
    return v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
}

int area(struct Poly p) {
    int a = 0;
    for (int i = 0; i < 4; i++) a += p.pts[i].x * p.pts[i].y;
    return a + p.grid[1][1] + p.key[0];
}

struct Poly relabel(struct Poly p, const char* name) {
    size_t i = 0;
    for (; i < POLY_NAME_MAX - 1 && name[i]; i++) p.name[i] = name[i];
    p.name[i] = 0;
    p.key[3] = 9;
    return p;
}

/* A sequence of structs the shim converts through a temporary. */
int total_pts(const struct Poly polys[], size_t n) {
    int t = 0;
    for (size_t i = 0; i < n; i++) t += (int)strlen(polys[i].name);
    return t;
}

int trace(const int m[2][2]) {
    return m[0][0] + m[1][1];
}

/* Hidden: not const, no length, a pointer, two unsized dimensions. */
void scale(double xs[], size_t n) { for (size_t i = 0; i < n; i++) xs[i] *= 2; }
void f(const int xs[]) { (void)xs; }
void g(const double* xs, size_t n) { (void)xs; (void)n; }
void h(const double m[][3], int rows) { (void)m; (void)rows; }
