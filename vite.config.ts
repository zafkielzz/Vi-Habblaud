import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Habblaud client. In `npm run dev` server uses this config in middleware mode;
// `npm run dev:client` starts Vite only (use ?mock=1 for simulated browser data).
export default defineConfig({
  root: r('./client'),
  // Only the active language's dictionary goes to the browser (client/src/main.ts): see shared/locales/all.ts.
  resolve: { alias: [{ find: /^\.\/locales\/all$/, replacement: r('./shared/locales/none.ts') }] },
  publicDir: r('./client/public'),
  build: {
    outDir: r('./dist/client'),
    emptyOutDir: true,
    // Hashed output bundles go to /bundle/ (immutable server cache); /assets/ is reserved for
    // client/public (fixed names, revalidated on each request). See server/http/static.ts.
    assetsDir: 'bundle',
    assetsInlineLimit: 0,
    rollupOptions: { input: { main: r('./client/index.html') } },
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.HABBLAUD_PORT ?? 4747}` },
    },
  },
});
