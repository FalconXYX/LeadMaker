import { describe, expect, it } from 'vitest';
import { LOCAL_DATABASE_URL, databaseUrl, prisma } from '../src/index.ts';

describe('databaseUrl', () => {
  it('prefers DATABASE_URL', () => {
    expect(databaseUrl({ DATABASE_URL: 'postgres://u@h/db', NODE_ENV: 'production' })).toBe('postgres://u@h/db');
  });

  it('falls back to the local compose database outside production', () => {
    expect(databaseUrl({})).toBe(LOCAL_DATABASE_URL);
    expect(databaseUrl({ NODE_ENV: 'test' })).toBe(LOCAL_DATABASE_URL);
  });

  it('refuses to guess in production', () => {
    expect(() => databaseUrl({ NODE_ENV: 'production' })).toThrow('DATABASE_URL is not set');
  });
});

describe('prisma singleton', () => {
  it('is shared through globalThis so reloaded modules reuse one pool', async () => {
    expect((globalThis as { __leadmakerPrisma?: unknown }).__leadmakerPrisma).toBe(prisma);
    const fresh = '../src/index.ts?fresh-module-instance';
    const again = await import(fresh);
    expect(again.prisma).toBe(prisma);
  });
});
