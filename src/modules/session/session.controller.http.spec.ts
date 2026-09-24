import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { AuditService } from '../audit/audit.service';
import { ChatScopeService } from '../auth/chat-scope.service';

// Nest answers a handler's returned null with an empty body, so the documented JSON `null` can only
// be seen through a real Nest/Express app.
describe('SessionController over HTTP: GET presence', () => {
  let app: INestApplication<App>;
  const getPresence = jest.fn();
  const url = '/sessions/0a941dac-a965-45e7-b318-74ae8be134f0/presence/628123@c.us';

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [SessionController],
      providers: [
        { provide: SessionService, useValue: { getPresence } },
        { provide: AuditService, useValue: {} },
        ChatScopeService,
      ],
    }).compile();
    app = mod.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers a JSON null when nothing has been reported', async () => {
    getPresence.mockResolvedValue(null);
    const res = await request(app.getHttpServer()).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.text).toBe('null');
  });

  it('answers the presence with observedAt as an ISO timestamp', async () => {
    getPresence.mockResolvedValue({ chatId: '628123@c.us', participants: [], observedAt: 1_786_000_000_000 });
    const res = await request(app.getHttpServer()).get(url);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      chatId: '628123@c.us',
      participants: [],
      observedAt: new Date(1_786_000_000_000).toISOString(),
    });
  });
});
