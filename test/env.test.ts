import { afterEach, describe, expect, it } from 'vitest';
import { env, resetEnvCache } from '../src/config/env.js';

describe('env', () => {
  afterEach(() => {
    delete process.env.A2A_HOST;
    delete process.env.DASHBOARD_HOST;
    resetEnvCache();
  });

  it.each(['A2A_HOST', 'DASHBOARD_HOST'])('keeps %s on loopback: the servers have no authentication', (key) => {
    process.env[key] = '0.0.0.0';
    resetEnvCache();
    expect(() => env()).toThrow(/127\.0\.0\.1 or localhost/);
    process.env[key] = 'localhost';
    resetEnvCache();
    expect(env()[key as 'A2A_HOST' | 'DASHBOARD_HOST']).toBe('localhost');
  });
});
