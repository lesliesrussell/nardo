#!/usr/bin/env bun
// Thin entry shim — catches native module load failures before they reach the user as raw crashes.
export {}

try {
  await import('./index.js')
} catch (e: unknown) {
  const msg = String(e)
  const isNative =
    msg.includes('hnswlib') ||
    msg.includes('NODE_MODULE_VERSION') ||
    msg.includes('was compiled against a different') ||
    msg.includes('Cannot find module') ||
    // Bun native addon error patterns
    msg.includes('.node') && msg.includes('load')

  if (isNative) {
    console.error(`
nardo: failed to load native bindings (hnswlib-node).

This usually means the binary wasn't compiled for your platform or runtime.

Try:
  1. Rebuild native modules:
       cd $(npm root -g)/nardo && npm rebuild hnswlib-node

  2. Check build prerequisites:
       macOS:   xcode-select --install
       Ubuntu:  sudo apt-get install build-essential python3
       Fedora:  sudo dnf install gcc-c++ make python3

  3. Verify platform support:
       hnswlib-node supports macOS (arm64/x64), Linux (x64/arm64), and Windows (x64).
       ARM Linux (Raspberry Pi) requires building from source.

If this keeps happening, open an issue:
  https://github.com/lesliesrussell/nardo/issues
`)
    process.exit(1)
  }

  // Known user-facing errors (start with "nardo:") — print clean, no stack
  if (e instanceof Error && e.message.startsWith('nardo:')) {
    console.error(e.message)
    process.exit(1)
  }

  // Re-throw unknown errors (e.g. user code bugs) as-is
  throw e
}
