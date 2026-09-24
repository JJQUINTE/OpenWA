import { DECORATORS } from '@nestjs/swagger';
import { StatusDto } from './status-response.dto';

// The GET status routes answer from the status store (StatusStoreService.toStatus), not the engine, so
// the published schema must describe that shape: a gateway media path, and no inline media bytes.
describe('StatusDto', () => {
  const property = (name: string): { description?: string } | undefined =>
    Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, StatusDto.prototype, name) as
      { description?: string } | undefined;

  it('does not advertise a media field the store never returns', () => {
    expect(property('media')).toBeUndefined();
  });

  it('describes mediaUrl as the authenticated gateway media route', () => {
    expect(property('mediaUrl')?.description).toMatch(/\/sessions\/\{sessionId\}\/status\/\{statusId\}\/media/);
    expect(property('mediaUrl')?.description).toMatch(/X-API-Key/);
  });
});
