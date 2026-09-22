import { isMediaUrl } from './media-url';

// Both engines fetch only a string that starts with http(s):// and decode anything else as base64,
// so every other value must be refused before it reaches them.
describe('isMediaUrl', () => {
  it.each([
    'example.com/a.jpg',
    'ftp://example.com/a.jpg',
    'file:///srv/a.jpg',
    'mailto:a@b.c',
    'http:example.com/a.jpg',
    'https:cdn.example.com/a.jpg',
    'https//cdn.example.com/a.jpg',
    'https://',
    'https://exa mple.com/a.jpg',
    '',
    42,
    undefined,
  ])('refuses %p', value => {
    expect(isMediaUrl(value)).toBe(false);
  });

  it.each([
    'https://example.com/a.jpg',
    'HTTPS://EXAMPLE.COM/a.jpg',
    'http://media-store/a.jpg',
    'http://media_server:8080/a.jpg',
    'https://cdn.example.com/my photo.jpg',
    `https://bucket.s3.amazonaws.com/k.jpg?X-Amz-Security-Token=${'a'.repeat(2100)}`,
  ])('accepts %s', value => {
    expect(isMediaUrl(value)).toBe(true);
  });
});
