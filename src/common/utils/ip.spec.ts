import { normalizeIp, ipMatches, limiterKeyForIp } from './ip';

describe('normalizeIp', () => {
  it('strips an IPv4-mapped IPv6 prefix', () => {
    expect(normalizeIp('::ffff:172.18.0.1')).toBe('172.18.0.1');
  });

  it('leaves a plain IPv4 address untouched', () => {
    expect(normalizeIp('10.0.0.1')).toBe('10.0.0.1');
  });

  it('leaves a real IPv6 address untouched', () => {
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('limiterKeyForIp', () => {
  it('gives two IPv6 addresses in one /64 the same key', () => {
    expect(limiterKeyForIp('2001:db8:1:2::a')).toBe(limiterKeyForIp('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(limiterKeyForIp('2001:db8:1:2::a')).toBe('2001:db8:1:2::/64');
  });

  it('keeps IPv6 addresses in different /64s apart', () => {
    expect(limiterKeyForIp('2001:db8:1:2::a')).not.toBe(limiterKeyForIp('2001:db8:1:3::a'));
  });

  it('keys IPv4 and loopback as they are, and an IPv4-mapped address as its IPv4 form', () => {
    expect(limiterKeyForIp('203.0.113.7')).toBe('203.0.113.7');
    expect(limiterKeyForIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(limiterKeyForIp('::1')).toBe('::1');
    expect(limiterKeyForIp('')).toBe('');
  });
});

describe('ipMatches', () => {
  it('matches an exact IP', () => {
    expect(ipMatches('10.0.0.5', '10.0.0.5')).toBe(true);
    expect(ipMatches('10.0.0.6', '10.0.0.5')).toBe(false);
  });

  it('matches within an IPv4 CIDR range', () => {
    expect(ipMatches('172.18.3.4', '172.18.0.0/16')).toBe(true);
    expect(ipMatches('172.19.0.1', '172.18.0.0/16')).toBe(false);
  });

  it('normalizes an IPv4-mapped IPv6 address before matching a CIDR', () => {
    expect(ipMatches('::ffff:172.18.0.9', '172.18.0.0/16')).toBe(true);
  });

  it('handles /32 and /0 boundaries', () => {
    expect(ipMatches('1.2.3.4', '1.2.3.4/32')).toBe(true);
    expect(ipMatches('1.2.3.5', '1.2.3.4/32')).toBe(false);
    expect(ipMatches('9.9.9.9', '0.0.0.0/0')).toBe(true);
  });

  it('returns false for malformed input rather than throwing', () => {
    expect(ipMatches('not-an-ip', '10.0.0.0/8')).toBe(false);
    expect(ipMatches('10.0.0.1', 'garbage/99')).toBe(false);
  });
});
