#include <array>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

struct Point { int x; int y; };
struct Shape { std::vector<Point> pts; std::string name; };

std::vector<int> evens(const std::vector<int>& xs) {
    std::vector<int> r;
    for (int x : xs) if (x % 2 == 0) r.push_back(x);
    return r;
}

std::vector<std::string> split(const std::string& s) {
    std::vector<std::string> r;
    std::string cur;
    for (char c : s) {
        if (c == ' ') { r.push_back(cur); cur.clear(); }
        else cur += c;
    }
    r.push_back(cur);
    return r;
}

std::array<float, 3> cross(const std::array<float, 3>& a, const std::array<float, 3>& b) {
    return { a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0] };
}

std::vector<std::vector<int>> transpose(std::vector<std::vector<int>> m) {
    std::vector<std::vector<int>> t(m.empty() ? 0 : m[0].size(), std::vector<int>(m.size()));
    for (size_t i = 0; i < m.size(); i++)
        for (size_t j = 0; j < m[i].size(); j++) t[j][i] = m[i][j];
    return t;
}

std::vector<uint8_t> reverse_bytes(const std::vector<uint8_t>& data) {
    return std::vector<uint8_t>(data.rbegin(), data.rend());
}

size_t count_true(const std::vector<bool>& flags) {
    size_t n = 0;
    for (bool f : flags) n += f;
    return n;
}

Shape close(Shape s) {
    if (!s.pts.empty()) s.pts.push_back(s.pts.front());
    s.name += "!";
    return s;
}

// Throws after building part of a result: the exception is the whole answer.
std::vector<int> throws_midway(const std::vector<int>& xs) {
    std::vector<int> r(xs.begin(), xs.end());
    if (r.size() > 2) throw std::runtime_error("too many");
    return r;
}

// C-style arrays of std types: the mirror converts each element.
struct Tagged { std::string tags[2]; std::vector<int> rows[2]; };

Tagged tag_up(Tagged t) {
    for (auto& tag : t.tags) tag += "!";
    for (auto& row : t.rows) for (int& x : row) x *= 2;
    return t;
}

// Hidden: a mutable reference.
void sort_in_place(std::vector<int>& xs) { (void)xs; }
