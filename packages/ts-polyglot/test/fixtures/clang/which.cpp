// Says whether clang compiled this file, so tests can tell which C++ compiler ts-polyglot picked.
int cpp_by_clang() {
#ifdef __clang__
    return 1;
#else
    return 0;
#endif
}
