import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { callChatRpc, throwChatRpcError } from './chat-rpc-error';

describe('throwChatRpcError', () => {
  it.each([
    ['P0002', NotFoundException],
    ['42501', ForbiddenException],
    ['22023', BadRequestException],
    ['23514', BadRequestException],
    ['23505', ConflictException],
    ['XX000', InternalServerErrorException],
    [undefined, InternalServerErrorException],
  ])('maps SQLSTATE %s', (code, exception) => {
    expect(() => throwChatRpcError({ code, message: 'chat: nope' })).toThrow(
      exception,
    );
  });

  it('strips the "chat:" prefix from client-facing messages', () => {
    expect(() =>
      throwChatRpcError({
        code: '42501',
        message: 'chat: only owners can remove members',
      }),
    ).toThrow('only owners can remove members');
  });

  it('never forwards the constraint name of a raw unique violation', () => {
    expect(() =>
      throwChatRpcError({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "chat_messages_pkey"',
      }),
    ).toThrow(new ConflictException('Conflict'));

    // A conflict the functions raise themselves keeps its text.
    expect(() =>
      throwChatRpcError({
        code: '23505',
        message: 'chat: message id already used',
      }),
    ).toThrow(new ConflictException('message id already used'));
  });

  it('answers 400 without the database text when a date cannot be read', () => {
    // 22008 = 31 February, 22007 = not a timestamp at all (search from / to).
    for (const [code, message] of [
      ['22008', 'date/time field value out of range: "2026-02-31"'],
      ['22007', 'invalid input syntax for type timestamp with time zone: "x"'],
    ]) {
      expect(() => throwChatRpcError({ code, message })).toThrow(
        new BadRequestException('Invalid date'),
      );
    }
  });

  it('never leaks the raw database message on unknown errors', () => {
    expect(() =>
      throwChatRpcError({
        code: 'XX000',
        message: 'relation secret_table does not exist',
      }),
    ).toThrow('Chat request failed');
  });
});

describe('callChatRpc', () => {
  it('returns data and passes the function name and args through', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: 'conv-1', error: null });

    await expect(
      callChatRpc({ rpc }, 'chat_get_or_create_dm', { p_a: 1 }),
    ).resolves.toBe('conv-1');
    expect(rpc).toHaveBeenCalledWith('chat_get_or_create_dm', { p_a: 1 });
  });

  it('throws the mapped exception when the function raises', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { code: 'P0002', message: 'chat: conversation not found' },
    });

    await expect(callChatRpc({ rpc }, 'chat_leave', {})).rejects.toThrow(
      NotFoundException,
    );
  });
});
