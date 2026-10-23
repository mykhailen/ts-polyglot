// Named like libc's random(): the addon has to call this one, not libc's.
int random(int x) {
    return x * 2;
}
