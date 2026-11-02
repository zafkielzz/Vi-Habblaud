// Optional dependencies of the interactive terminal (optionalDependencies): loaded with dynamic import() and used
// only by local types (manager.ts, screen.ts). Declared here so typecheck does not depend on them being installed.
declare module 'node-pty';
declare module '@xterm/headless';
declare module '@xterm/addon-serialize';
