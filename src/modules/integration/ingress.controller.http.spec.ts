import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { IngressController } from './ingress.controller';
import { IngressService } from './ingress.service';
import { InstanceThrottlerGuard } from './instance-throttler.guard';

// The controller spec's fake Response never runs Express's send(), so it cannot see a Content-Type that
// Express rejects while writing. This one answers through a real Nest/Express app.
describe('IngressController over HTTP: declared ack Content-Type', () => {
  let app: INestApplication<App>;
  let declared = '';
  const handle = jest.fn(() => Promise.resolve({ status: 200, body: '{}', headers: { 'Content-Type': declared } }));

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [IngressController],
      providers: [{ provide: IngressService, useValue: { handle } }],
    })
      .overrideGuard(InstanceThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = mod.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['application/json', 'application/json; charset=utf-8'],
    ['application/json;', 'application/json; charset=utf-8'],
    ['application/json; charset=utf-8;', 'application/json; charset=utf-8'],
    ['application/json; foo', 'application/json; charset=utf-8'],
    ['text/plain;', 'text/plain; charset=utf-8'],
  ])('answers the ack for a declared %p', async (value, wire) => {
    declared = value;
    const res = await request(app.getHttpServer()).post('/ingress/p/i/hook').send('{}');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(wire);
    expect(res.text).toBe('{}');
  });
});
