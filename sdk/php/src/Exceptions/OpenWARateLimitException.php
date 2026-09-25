<?php

declare(strict_types=1);

namespace OpenWA\Exceptions;

/**
 * 429 Too Many Requests — rate limited.
 *
 * The global rate limiter's 429 clears within seconds; its delay is only in the Retry-After
 * response header, which this exception does not carry. A 429 whose body has
 * code "SEND_PACING_LIMITED" is not transient: do not retry it before the body's
 * retryAfterSeconds, which can be hours.
 */
class OpenWARateLimitException extends OpenWAApiException
{
}
