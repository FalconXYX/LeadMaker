import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@leadmaker/db';
import { loadConfig } from '../src/config.ts';
import { HttpError } from '../src/http.ts';
import { areaDedupeKey, formatG } from '../src/routes/refresh.ts';
import { writer } from '../src/tx.ts';
import type { Actor } from '../src/auth.ts';

const manager: Actor = { id: '00000000-0000-4000-8000-000000000001', role: 'manager', name: 'M' };

describe('refresh dedupe key', () => {
  it('formats the radius like Python f"{radius:g}", as leadmaker/jobs.py area_dedupe_key does', () => {
    expect(formatG(25)).toBe('25');
    expect(formatG(25.0)).toBe('25');
    expect(formatG(12.5)).toBe('12.5');
    expect(formatG(0.1)).toBe('0.1');
    expect(formatG(100)).toBe('100');
    expect(formatG(33.333333)).toBe('33.3333');
    expect(formatG(99.9999999)).toBe('100');
    expect(areaDedupeKey('scrape', '10013', 25)).toBe('scrape:10013:25:*');
    expect(areaDedupeKey('scrape', '07030', 7.5)).toBe('scrape:07030:7.5:*');
  });
});

describe('config', () => {
  it('reads the shared per-user job limit and falls back to local defaults outside production', () => {
    const c = loadConfig({ LEADMAKER_USER_JOBS_PER_HOUR: '5' });
    expect(c).toMatchObject({ userJobsPerHour: 5, port: 8082, redisUrl: 'redis://localhost:56379' });
    expect(loadConfig({}).userJobsPerHour).toBe(20);
    expect(loadConfig({ LEADMAKER_USER_JOBS_PER_HOUR: '0' }).userJobsPerHour).toBe(0);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/INTERNAL_TOKEN/);
    expect(() => loadConfig({ LEADMAKER_USER_JOBS_PER_HOUR: 'many' })).toThrow();
  });

  it('rejects numeric settings that are not integers in range instead of silently disabling a limit', () => {
    expect(loadConfig({ MAX_BULK_ALLOCATION: '250', PORT: '9000' })).toMatchObject({ maxBulkAllocation: 250, port: 9000 });
    expect(loadConfig({})).toMatchObject({ maxBulkAllocation: 5000, maxBulkTag: 500, maxBulkUnallocate: 500 });
    expect(loadConfig({ MAX_BULK_ALLOCATION: '40', MAX_BULK_TAG: '25' })).toMatchObject({ maxBulkTag: 25, maxBulkUnallocate: 40 });
    expect(() => loadConfig({ MAX_BULK_TAG: 'x' })).toThrow(/MAX_BULK_TAG/);
    expect(() => loadConfig({ MAX_BULK_ALLOCATION: 'lots' })).toThrow(/MAX_BULK_ALLOCATION/);
    expect(() => loadConfig({ MAX_BULK_ALLOCATION: '0' })).toThrow(/MAX_BULK_ALLOCATION/);
    expect(() => loadConfig({ PORT: '80a' })).toThrow(/PORT/);
    expect(() => loadConfig({ LEADMAKER_USER_JOBS_PER_HOUR: '2.5' })).toThrow(/LEADMAKER_USER_JOBS_PER_HOUR/);
  });
});

describe('writer', () => {
  const pgError = (code: string) => Object.assign(new Error(code), { meta: { driverAdapterError: { cause: { originalCode: code } } } });
  const log = pino({ level: 'silent' });

  it('reruns a transaction rolled back by a deadlock or serialization failure, then gives up', async () => {
    const $transaction = vi.fn()
      .mockRejectedValueOnce(pgError('40P01'))
      .mockRejectedValueOnce(pgError('40001'))
      .mockResolvedValueOnce('ok');
    const redis = { set: vi.fn().mockResolvedValue('OK') };
    const write = writer({ $transaction } as unknown as PrismaClient, redis as never, log);
    expect(await write(manager, async () => 'unused')).toBe('ok');
    expect($transaction).toHaveBeenCalledTimes(3);
    expect(redis.set).toHaveBeenCalledWith(`rw:${manager.id}`, expect.any(String), 'EX', 5);

    const always = vi.fn().mockRejectedValue(pgError('40P01'));
    await expect(writer({ $transaction: always } as unknown as PrismaClient, null, log)(manager, async () => 1)).rejects.toThrow('40P01');
    expect(always).toHaveBeenCalledTimes(3);
  });

  it('does not rerun other errors or set the read-your-writes marker after a failure', async () => {
    const $transaction = vi.fn().mockRejectedValue(pgError('23505'));
    const redis = { set: vi.fn() };
    await expect(writer({ $transaction } as unknown as PrismaClient, redis as never, log)(manager, async () => 1)).rejects.toThrow();
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('keeps a committed write when Redis is down', async () => {
    const $transaction = vi.fn().mockResolvedValue('done');
    const redis = { set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    expect(await writer({ $transaction } as unknown as PrismaClient, redis as never, log)(manager, async () => 1)).toBe('done');
  });
});
