import { ValidateBy, ValidationArguments } from 'class-validator';

const HTTP_URL_PREFIX = /^https?:\/\//i;

export const MEDIA_URL_MESSAGE = 'url must be an absolute http(s) URL';

/**
 * The rule for a caller-supplied media URL. Both engines fetch only a string that starts with
 * `http://` or `https://` and decode anything else as base64, so that literal prefix is required. The
 * rest must parse as a WHATWG URL with a host, which is what the fetch accepts: a space in the path is
 * percent-encoded there, not refused. The host itself is left to the SSRF-guarded fetch, so a
 * single-label host named in SSRF_ALLOWED_HOSTS and a long presigned URL are fine.
 */
export const isMediaUrl = (value: unknown): boolean => {
  if (typeof value !== 'string' || !HTTP_URL_PREFIX.test(value)) return false;
  try {
    return new URL(value).hostname !== '';
  } catch {
    return false;
  }
};

/** {@link isMediaUrl} as a class-validator decorator; `ignoreWhen` skips the check for that object. */
export const IsMediaUrl = <T extends object>(
  options: { ignoreWhen?: (object: T) => boolean } = {},
): PropertyDecorator =>
  ValidateBy({
    name: 'isMediaUrl',
    validator: {
      validate: (value: unknown, args?: ValidationArguments) =>
        (args !== undefined && options.ignoreWhen?.(args.object as T) === true) || isMediaUrl(value),
      defaultMessage: () => MEDIA_URL_MESSAGE,
    },
  });
