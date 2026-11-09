import { Prisma } from '@prisma/client';
import { isBusy } from './gate.service';

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test', meta });

describe('isBusy', () => {
  it('counts every way the gate runs out of its budget', () => {
    expect(isBusy(known('P2028'))).toBe(true);
    expect(isBusy(known('P2024'))).toBe(true);
    expect(isBusy(known('P2010', { code: '55P03' }))).toBe(true);
    const unclassified = new Prisma.PrismaClientUnknownRequestError('ERROR: canceling statement due to lock timeout', {
      clientVersion: 'test',
    });
    expect(isBusy(unclassified)).toBe(true);
    expect(isBusy(new Error('Code: `55P03`. Message: `lock_not_available`'))).toBe(true);
  });

  it('leaves every other failure alone', () => {
    expect(isBusy(known('P2002', { target: ['gateId'] }))).toBe(false);
    expect(isBusy(new Error('connection refused'))).toBe(false);
    expect(isBusy('55P03')).toBe(false);
  });
});
