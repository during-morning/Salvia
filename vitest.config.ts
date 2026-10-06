import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    // Tests keep their database, settings and history away from the user's ~/.salvia.
    env: { SALVIA_HOME: process.env.SALVIA_HOME ?? mkdtempSync(join(tmpdir(), 'salvia-test-')) },
  },
});
