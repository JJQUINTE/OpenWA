import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsNotEmpty, IsString, Matches, ValidateIf } from 'class-validator';

/**
 * Ceiling on one request's receipt batch, so a single call cannot hand the engine an unbounded key
 * list to round-trip. A caller with more than this to acknowledge is catching up on history rather
 * than marking a conversation read.
 */
export const MARK_READ_MESSAGE_IDS_MAX = 100;

/**
 * The shape of one message id: a single non-whitespace token. Exported for the same reason as the
 * cap above, so the agent tool holds the rule rather than restating it. Restating it is how the two
 * surfaces drifted: the tool copied the count and left `['  ']` reaching the engine as a receipt key.
 */
export const MARK_READ_MESSAGE_ID_PATTERN = /^\S{1,128}$/;

/** Rejection message for {@link MARK_READ_MESSAGE_ID_PATTERN}, shared so both surfaces answer alike. */
export const MARK_READ_MESSAGE_ID_MESSAGE = 'each messageIds entry must be a non-empty id with no whitespace';

export class MarkChatReadDto {
  @ApiProperty({
    description: "Chat ID in the active engine's native format (e.g. 1234567890@c.us on whatsapp-web.js)",
    example: '1234567890@c.us',
  })
  @IsString()
  @IsNotEmpty()
  // Engine-neutral structural check (localpart@host, no whitespace) so a different engine's JID
  // scheme (e.g. Baileys 1234@s.whatsapp.net) is accepted too; the adapter validates/normalises
  // further for its own engine. Keeps the early-400 on obvious garbage without coupling to wwebjs.
  @Matches(/^[^\s@]+@[^\s@]+$/, {
    message: 'chatId must be a valid chat JID in the form localpart@host',
  })
  chatId!: string;

  @ApiPropertyOptional({
    description:
      'Specific message IDs to mark read. Baileys acknowledges individual messages, so without this ' +
      'only the newest received message the engine still holds in memory gets a receipt — a burst leaves its ' +
      'earlier messages unread forever, and a restarted session has no message to acknowledge at all. ' +
      'Callers that persist inbound message IDs should send them here. Ignored by whatsapp-web.js, ' +
      'whose own sendSeen is chat-level.',
    type: [String],
    // @ArrayMaxSize is runtime-only; @nestjs/swagger does not derive maxItems from it, so without
    // this the published schema advertises an unbounded array and a caller batching more than the
    // cap discovers the limit as a 400.
    maxItems: MARK_READ_MESSAGE_IDS_MAX,
    // @ArrayNotEmpty rejects [], so the published schema has to say so too; without minItems the
    // contract advertised an empty array as valid against a server that answers 400.
    minItems: 1,
    example: ['3EB0C767D26B8A3F1A2B', '3EB0C767D26B8A3F1A2C'],
  })
  // Not @IsOptional: that skips every validator for null as well as undefined, so an explicit
  // `"messageIds": null` reached the engine unchecked and dereferenced there as a 500. Absent stays
  // absent; present-but-null falls through to @IsArray and answers 400.
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  // An empty array asks for nothing to be acknowledged. Rejected rather than accepted, because the
  // engine reads a missing list as "the newest message" and the two must not collapse: a caller that
  // computed its unread set and got none back would otherwise acknowledge a message it never named.
  @ArrayNotEmpty()
  @ArrayMaxSize(MARK_READ_MESSAGE_IDS_MAX)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @Matches(MARK_READ_MESSAGE_ID_PATTERN, { each: true, message: MARK_READ_MESSAGE_ID_MESSAGE })
  messageIds?: string[];
}
