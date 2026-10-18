// Vitest runs everything in a Node context, which is always "server" —
// this shim replaces the real `server-only` package (which unconditionally
// throws outside of Next.js's own bundler aliasing) for test runs only.
export {};
