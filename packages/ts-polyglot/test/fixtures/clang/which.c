// Says whether clang compiled this file, so tests can tell which compiler ts-polyglot picked.
int c_by_clang(void) {
#ifdef __clang__
    return 1;
#else
    return 0;
#endif
}
