import { AuthValidateController } from './auth-validate.controller';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { EngineFactory } from '../../engine/engine.factory';

describe('AuthValidateController', () => {
  const engineFactory = { getCurrentEngine: () => 'baileys' } as unknown as EngineFactory;
  const controller = new AuthValidateController(engineFactory);

  const makeKey = (over: Partial<ApiKey> = {}): ApiKey =>
    ({ id: 'k1', role: ApiKeyRole.OPERATOR, isActive: true, allowedIps: null, ...over }) as ApiKey;

  it('reports the guard-validated key as valid, echoing its role and the running engine', () => {
    expect(controller.validate(makeKey({ role: ApiKeyRole.ADMIN }))).toEqual({
      valid: true,
      role: ApiKeyRole.ADMIN,
      engineType: 'baileys',
    });
  });

  it('reports the engine to an operator key, which cannot read the admin-only infra route', () => {
    // The dashboard needs the engine to gate status compose and the Channels tab for every writer.
    expect(controller.validate(makeKey({ role: ApiKeyRole.OPERATOR }))).toMatchObject({ engineType: 'baileys' });
  });

  it('returns valid:true for an IP-restricted key (no IP-less re-validation false negative)', () => {
    // The global guard already validated this key against the real client IP and attached it.
    // The handler must NOT re-validate without an IP, which previously fail-closed and wrongly
    // reported valid:false for any key carrying an allowedIps restriction.
    const key = makeKey({ allowedIps: ['10.0.0.0/24'] });
    expect(controller.validate(key)).toEqual({ valid: true, role: key.role, engineType: 'baileys' });
  });

  it('returns valid:false when no key is attached (defense-in-depth)', () => {
    expect(controller.validate(undefined)).toEqual({ valid: false });
  });
});
