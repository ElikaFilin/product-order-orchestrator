import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    env: {
      DASHBOARD_ENABLED: '0',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      LOG_LEVEL: 'silent',
    },
  },
});
