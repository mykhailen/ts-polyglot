import { c_by_clang } from "./which.c";
import { cpp_by_clang } from "./which.cpp";

console.log(JSON.stringify({ c: c_by_clang(), cpp: cpp_by_clang() }));
