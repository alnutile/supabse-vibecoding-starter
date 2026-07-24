/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Production serves the build with `vite preview` (see `npm start`). Vite's
  // preview server rejects requests whose Host it doesn't recognize with a 403
  // ("This host is not allowed"). Railway serves every service on a generated
  // `*.up.railway.app` domain, so allow that whole suffix — this works for any
  // project spun from this template, with no per-project edit. If you map a
  // custom domain, add it to this list too.
  preview: {
    allowedHosts: ['.up.railway.app'],
  },
  test: {
    // Only run the app's own tests. Skills under `.claude/` may ship reference
    // test files that shouldn't be collected into this project's suite.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Placeholder public values so the Supabase client constructs under test.
    env: {
      VITE_SUPABASE_URL: 'https://placeholder.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'sb_publishable_placeholder',
    },
  },
})
