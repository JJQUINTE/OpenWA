package com.rmyndharis.openwa.model;

/** A WhatsApp session. Optional fields are {@code null} when absent. */
public record SessionResponse(
    String id,
    String name,
    SessionStatus status,
    String phone,
    String pushName,
    String connectedAt,
    String lastActive,
    String createdAt,
    String updatedAt,
    /** Present when {@code status == FAILED} or {@code status == ACTION_REQUIRED}. */
    String lastError,
    /**
     * A limit WhatsApp itself has placed on the account, or {@code null} when there is none.
     * Distinct from {@code lastError}, which describes a fault on the gateway's side.
     */
    AccountRestriction restriction,
    /**
     * Whether the gateway holds a live engine for this session: an engine in the answering process
     * or, in a multi-node deployment, a live claim by the node running it. On the node running the
     * session, {@code true} means {@code stop}, {@code logout} and {@code force-kill} can act and
     * {@code start} is refused. For a session another node runs, those routes act only when request
     * routing ({@code NODE_URL} on every node) forwards them; without it, other nodes answer 409 to
     * {@code start} and {@code stop} and 400 to {@code logout} and {@code force-kill}. Not
     * derivable from {@code status}, since {@code DISCONNECTED} covers both a session mid
     * automatic-reconnect (engine present) and one stopped with no engine. {@code null} from a
     * gateway older than the field.
     */
    Boolean engineLoaded) {}
