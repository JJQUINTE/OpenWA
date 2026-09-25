package com.rmyndharis.openwa.errors;

/**
 * 429 Too Many Requests — rate limited.
 *
 * <p>The global rate limiter's 429 lifts when its window expires (seconds for the per-second tier,
 * up to an hour for the hourly tier by default); its delay is only in the {@code Retry-After}
 * response header, which this error does not carry. A 429 whose body has {@code code:
 * "SEND_PACING_LIMITED"} is not transient: do not retry it before the body's {@code
 * retryAfterSeconds}, which can be hours.
 */
public class OpenWARateLimitError extends OpenWAApiError {
    public OpenWARateLimitError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
