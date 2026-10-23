# The Linux environment for `npm run test:linux` (scripts/linux.cjs): Node 22 with gcc, g++ and make
# from the image, plus clang for the compiler-choice tests and Rust for .rs files.
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends clang && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
