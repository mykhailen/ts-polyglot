// helper() is declared but defined nowhere, as when a project's other C files aren't built with it.
int helper(int x);

int api(int x) {
    return helper(x);
}
