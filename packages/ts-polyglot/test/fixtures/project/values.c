// `long` is 64-bit on Linux and macOS, so values past 2^31 must survive the round trip there.
long echo_long(long x) {
    return x;
}
