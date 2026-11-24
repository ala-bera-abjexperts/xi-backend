/**
 * @fileoverview Maps the SQLSTATE codes raised by the chat_* Postgres functions
 * (migration 20260929120100_chat_core_functions.sql) to Nest HTTP exceptions.
 * @module src/chat/chat-rpc-error
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

/** Minimal shape of a PostgREST error. */
export interface ChatRpcError {
  code?: string;
  message: string;
}

/**
 * Throws the HTTP exception matching a chat RPC error:
 * P0002 → 404, 42501 → 403, 22023/23514 → 400, 22007/22008 (unreadable date) → 400,
 * 23505 → 409, anything else → 500.
 * The functions prefix their messages with "chat: ", which is stripped for the client.
 * A 23505 without that prefix is a raw unique violation whose text names the
 * constraint: it stays a 409 but its text is never forwarded.
 */
export function throwChatRpcError(error: ChatRpcError): never {
  const message = error.message.replace(/^chat:\s*/, '');

  switch (error.code) {
    case 'P0002':
      throw new NotFoundException(message);
    case '42501':
      throw new ForbiddenException(message);
    case '22023':
    case '23514':
      throw new BadRequestException(message);
    case '22007':
    case '22008':
      // Raised by Postgres itself for a date it cannot read; its text is not ours.
      throw new BadRequestException('Invalid date');
    case '23505':
      throw new ConflictException(
        message === error.message ? 'Conflict' : message,
      );
    default:
      throw new InternalServerErrorException('Chat request failed');
  }
}

/** Anything with a Supabase-style `rpc` method (the service_role client). */
interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<unknown>;
}

/**
 * Calls a chat_* Postgres function and returns its data, throwing the mapped
 * HTTP exception when it raises.
 */
export async function callChatRpc<T = unknown>(
  client: RpcClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = (await client.rpc(fn, args)) as {
    data: T;
    error: ChatRpcError | null;
  };
  if (error) throwChatRpcError(error);

  return data;
}
