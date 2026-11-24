import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { Readable } from 'stream';
import { readFileSync } from 'fs';
import ts from 'typescript';
import { UPLOAD_LIMITS } from '../common/upload-limits';

type ControllerClass<T> = new (...args: unknown[]) => T;

interface ControllerContractOptions<T> {
  controller: ControllerClass<T>;
  sourceFile: string;
  skipDependencyFailurePropagation?: string[];
}

interface ParsedParam {
  decorator: string;
  name?: string;
  type?: string;
}

interface ParsedMethod {
  controllerName: string;
  name: string;
  httpDecorators: string[];
  params: ParsedParam[];
  hasFileGuard: boolean;
  hasFileSizeGuard: boolean;
  hasFileTypeGuard: boolean;
  usesControllerMember: boolean;
}

const HTTP_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete']);

/**
 * Size used to prove a controller's own `file.size` guard rejects.
 *
 * Must exceed the LARGEST tier any controller can resolve to. The previous 100 MB value happened to
 * work only on cloud: on-premise every tier lifts to at least 1 GiB (`maxUploadBytes`), so a 100 MB
 * fixture was a legal upload and the assertion inverted the moment `IS_ON_PREMISE=true` was set in
 * a test environment. Derived from the real ceiling rather than hardcoded so it cannot drift again.
 */
const OVERSIZED_FILE_BYTES =
  Math.max(...Object.values(UPLOAD_LIMITS)) + 1024 * 1024;

const mockUser = {
  authUserId: 'auth-user-1',
  userId: 'user-1',
  email: 'user@example.com',
  organizationId: 'org-1',
};

function mockFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'upload.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 1024,
    buffer: Buffer.from('test-file'),
    stream: new Readable(),
    destination: '',
    filename: '',
    path: '',
    ...overrides,
  };
}

function mockResponse() {
  const res = {
    cookie: jest.fn().mockReturnThis(),
    clearCookie: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    attachment: jest.fn().mockReturnThis(),
    redirect: jest.fn().mockReturnThis(),
  };
  return res;
}

function mockRequest() {
  return {
    cookies: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      oauth_state: 'oauth-state',
    },
    headers: {
      authorization: 'Bearer access-token',
      'user-agent': 'jest',
      'x-forwarded-for': '127.0.0.1',
    },
  };
}

function richResult(): any {
  const row: any = {
    id: 'entity-1',
    key: 'KEY-1',
    name: 'Test entity',
    title: 'Test entity',
    email: 'user@example.com',
    otp: '123456',
    resetLink: 'https://example.test/reset',
    firstName: 'Test',
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    token_type: 'bearer',
    signedUrl: 'https://example.test/file.png',
    url: 'https://example.test/file.png',
    csv: 'id,name\n1,Test',
    content: 'file-content',
    user: mockUser,
    profile: mockUser,
    organization: { id: 'org-1', name: 'Org' },
    spaces: [{ id: 'space-1' }],
    permissions: { can_view: true },
    session: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
    },
    tokens: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      token_type: 'bearer',
    },
    redirectTo: 'http://localhost:3000/dashboard',
    data: [{ id: 'entity-1' }],
    count: 1,
    total: 1,
    invitation: {
      id: 'invitation-1',
      email: 'user@example.com',
      expires_at: '2026-01-01T00:00:00Z',
      first_name: 'Test',
      last_name: 'User',
      role: 'member',
    },
    invitationLink: 'https://example.test/invite',
    organizationName: 'Org',
  };
  const result: any[] = [row];
  Object.assign(result, row);
  return result;
}

function richBody(): Record<string, unknown> {
  return {
    id: 'entity-1',
    email: 'user@example.com',
    password: 'Passw0rd!',
    token: '123456',
    code: 'auth-code',
    refreshToken: 'refresh-token',
    task_id: 'task-1',
    taskId: 'task-1',
    note: 'Test note',
    title: 'Test title',
    name: 'Test name',
    summary: 'Test summary',
    content: 'Test content',
    description: 'Test description',
    items: [{ id: 'item-1', sort_order: 0 }],
    records: [{ id: 'record-1' }],
    columns: [{ id: 'column-1' }],
    fields: [{ id: 'field-1' }],
    values: { field: 'value' },
    permissions: { view: true, edit: true },
    layout: [],
    settings: {},
    metadata: {},
    organization_id: 'org-1',
    organizationId: 'org-1',
    space_id: 'space-1',
    spaceId: 'space-1',
    board_id: 'board-1',
    boardId: 'board-1',
    schema_id: 'schema-1',
    schemaId: 'schema-1',
    item_id: 'item-1',
    itemId: 'item-1',
    parent_id: 'parent-1',
    parentId: 'parent-1',
    user_id: 'user-1',
    userId: 'user-1',
    target_column_id: 'column-2',
    targetColumnId: 'column-2',
    relation_type_id: 'relation-type-1',
    relationTypeId: 'relation-type-1',
    probability: 2,
    impact: 3,
    value: 6,
    limit: 10,
    page: 1,
    pageSize: 20,
    fileName: 'upload.png',
    file_name: 'upload.png',
    slot: 'primary',
    action: 'check_usage',
    is_active: true,
    newName: 'Copied name',
    new_name: 'Copied name',
    type: 'group',
    field_group_id: 'field-group-1',
    custom_field_id: 'custom-field-1',
    hierarchy_level: 'task',
    transition_to_ids: ['status-2'],
    to_status_id: 'status-2',
    permission: 'can_view_tasks',
    config: { taskTypes: [], linkTypes: [] },
  };
}

function queryObject(): Record<string, unknown> {
  return {
    search: 'search-term',
    q: 'search-term',
    page: 1,
    limit: 10,
    pageSize: 20,
    entityTypes: 'tasks,processes',
    spaceIds: 'space-1',
    spaceId: 'space-1',
    organizationId: 'org-1',
    taskId: 'task-1',
    userId: 'user-1',
    isArchived: false,
    isPublished: true,
    status: 'active',
    type: 'default',
    token: 'invite-token',
  };
}

function scalarFor(
  name: string | undefined,
  type: string | undefined,
): unknown {
  const key = name ?? '';
  if (type?.includes('number')) return 2;
  if (type?.includes('boolean')) return true;
  if (/^(page|pageSize|limit|offset|probability|impact|value)$/.test(key)) {
    return key === 'limit' ? 10 : 2;
  }
  if (/^(is_|is[A-Z]|include|with|everywhere)/.test(key)) return 'true';
  if (key === 'token') return 'invite-token';
  if (key === 'provider') return 'google';
  if (key === 'redirectTo' || key === 'returnUrl')
    return 'http://localhost:3000/dashboard';
  if (key === 'code') return 'oauth-code';
  if (key === 'prompt') return 'none';
  if (key === 'organization_id' || key === 'organizationId') return 'org-1';
  if (key === 'id') return 'org-1';
  if (key === 'type') return 'priority';
  if (key === 'email') return 'user@example.com';
  if (key === 'q' || key === 'search') return 'search-term';
  return `${key || 'value'}-1`;
}

function createStorageClientMock(): Record<string, unknown> {
  const storageBucket: Record<string, jest.Mock> = {
    upload: jest
      .fn()
      .mockResolvedValue({ data: richResult() as unknown, error: null }),
    createSignedUrl: jest.fn().mockResolvedValue({
      data: { signedUrl: 'https://example.test/file.png' },
      error: null,
    }),
    getPublicUrl: jest.fn().mockReturnValue({
      data: { publicUrl: 'https://example.test/file.png' },
    }),
    remove: jest.fn().mockResolvedValue({ data: [] as unknown[], error: null }),
    list: jest.fn().mockResolvedValue({
      data: [
        { name: 'file.png', metadata: { size: 10, mimetype: 'image/png' } },
      ],
      error: null,
    }),
  };

  return {
    storage: {
      from: jest.fn().mockReturnValue(storageBucket),
    },
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest
        .fn()
        .mockResolvedValue({ data: richResult() as unknown, error: null }),
    }),
  };
}

function createDependencyMock() {
  const methods = new Map<string | symbol, jest.Mock>();
  const target = {};

  return new Proxy(target, {
    get(_obj, prop) {
      if (prop === '__mockMethods') return methods;
      if (prop === 'get') return jest.fn().mockReturnValue(undefined);
      if (prop === 'getClient') {
        if (!methods.has(prop)) {
          methods.set(
            prop,
            jest
              .fn()
              .mockName(String(prop))
              .mockReturnValue(createStorageClientMock()),
          );
        }
        return methods.get(prop);
      }
      if (!methods.has(prop)) {
        methods.set(
          prop,
          jest.fn().mockName(String(prop)).mockResolvedValue(richResult()),
        );
      }
      return methods.get(prop);
    },
  });
}

function allMockFunctions(dependencies: unknown[]): jest.Mock[] {
  return dependencies.flatMap((dep) => {
    const typed = dep as { __mockMethods?: Map<string | symbol, jest.Mock> };
    return Array.from(typed.__mockMethods?.values() ?? []);
  });
}

function decoratorName(expr: ts.Expression): string | undefined {
  if (ts.isCallExpression(expr)) {
    const inner = expr.expression;
    if (ts.isIdentifier(inner)) return inner.text;
  }
  if (ts.isIdentifier(expr)) return expr.text;
  return undefined;
}

function firstStringArg(expr: ts.Expression): string | undefined {
  if (!ts.isCallExpression(expr)) return undefined;
  const arg = expr.arguments[0];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

function parseMethods(
  sourceFile: string,
  controllerName: string,
): ParsedMethod[] {
  const content = readFileSync(sourceFile, 'utf8');
  const ast = ts.createSourceFile(
    sourceFile,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const methods: ParsedMethod[] = [];

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.name?.text !== controllerName) {
      return;
    }

    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const decorators = ts.getDecorators(node) ?? [];
      const httpDecorators = decorators
        .map((decorator) => decoratorName(decorator.expression))
        .filter((name): name is string => !!name && HTTP_DECORATORS.has(name));

      if (httpDecorators.length > 0) {
        const bodyText = node.body?.getText(ast) ?? '';
        methods.push({
          controllerName,
          name: node.name.text,
          httpDecorators,
          hasFileGuard: /if\s*\(\s*!file\s*\)/.test(bodyText),
          hasFileSizeGuard: /if\s*\([^)]*file\.size/.test(bodyText),
          // Two shapes count as a type guard: a hand-rolled `if (...file.mimetype...)`, and a
          // call to the shared `assertImageMime` helper. Without the second the auto-generated
          // "rejects an unsupported type" test silently stopped being emitted for every
          // controller migrated onto the shared helper.
          hasFileTypeGuard:
            /if\s*\([^)]*file\.mimetype/.test(bodyText) ||
            /assertImage(?:OrVideo)?Mime\s*\(/.test(bodyText),
          usesControllerMember: /this\.[A-Za-z_$][\w$]*/.test(bodyText),
          params: node.parameters.map((param) => {
            const decorator = (ts.getDecorators(param) ?? [])[0];
            const decName = decorator
              ? decoratorName(decorator.expression)
              : undefined;
            return {
              decorator: decName ?? 'Unknown',
              name: decorator
                ? firstStringArg(decorator.expression)
                : undefined,
              type: param.type?.getText(ast),
            };
          }),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(ast);
  return methods;
}

function bodyFor(method: ParsedMethod): Record<string, unknown> {
  if (method.name === 'dispatch') {
    return {
      action: 'validate',
      config: {
        levels: [
          {
            id: 'root',
            name: 'Root',
            parent_level_id: null,
          },
        ],
      },
      spaceId: 'space-1',
    };
  }

  if (method.controllerName === 'SpacesController') {
    return {
      ...richBody(),
      overrides: {
        tasks: {
          can_view_tasks: true,
        },
      },
    };
  }

  if (method.name === 'patch') {
    if (method.controllerName === 'ProcessesController') {
      return { ...richBody(), action: 'partial_update', summary: 'Updated' };
    }
    if (method.controllerName === 'CustomFieldsController') {
      return { ...richBody(), action: 'toggle_active', is_active: true };
    }
    return {
      ...richBody(),
      action: 'duplicate',
      newName: 'Copied name',
      new_name: 'Copied name',
      items: [{ id: 'item-1', sort_order: 1 }],
    };
  }

  if (
    method.name === 'createLevelAssignment' ||
    method.name === 'deleteLevelAssignment'
  ) {
    return {
      type: 'group',
      field_group_id: 'field-group-1',
      hierarchy_level: 'task',
    };
  }

  if (method.name === 'updateFields') {
    return {
      custom_field_id: 'custom-field-1',
      display_order: 1,
      is_required: false,
    };
  }

  return richBody();
}

function argsFor(method: ParsedMethod): unknown[] {
  return method.params.map((param) => {
    switch (param.decorator) {
      case 'CurrentUser':
        return param.name
          ? (mockUser as Record<string, unknown>)[param.name]
          : mockUser;
      case 'Body':
        return param.name ? bodyFor(method)[param.name] : bodyFor(method);
      case 'Param':
        return scalarFor(param.name, param.type);
      case 'Query':
        return param.name ? scalarFor(param.name, param.type) : queryObject();
      case 'UploadedFile':
        return mockFile();
      case 'Req':
      case 'Request':
        return mockRequest();
      case 'Res':
      case 'Response':
        return mockResponse();
      case 'Headers':
        return param.name === 'x-forwarded-for' ? '127.0.0.1' : 'jest-agent';
      case 'Ip':
        return '127.0.0.1';
      default:
        return undefined;
    }
  });
}

function argsWithFile(
  method: ParsedMethod,
  file: Express.Multer.File | undefined,
): unknown[] {
  return method.params.map((param) =>
    param.decorator === 'UploadedFile'
      ? file
      : argsFor({ ...method, params: [param] })[0],
  );
}

export function runControllerContractSuite<T>({
  controller,
  sourceFile,
  skipDependencyFailurePropagation = [],
}: ControllerContractOptions<T>) {
  describe(`${controller.name} controller contract`, () => {
    const methods = parseMethods(sourceFile, controller.name);

    it('has an executable test case for every HTTP-decorated controller method', () => {
      expect(methods.length).toBeGreaterThan(0);
    });

    for (const method of methods) {
      describe(method.name, () => {
        let instance: Record<string, (...args: unknown[]) => unknown>;
        let dependencies: unknown[];

        beforeEach(() => {
          const paramTypes =
            (Reflect.getMetadata('design:paramtypes', controller) as
              | unknown[]
              | undefined) ?? new Array(controller.length).fill(undefined);
          dependencies = paramTypes.map(() => createDependencyMock());
          instance = new controller(...dependencies) as Record<
            string,
            (...args: unknown[]) => unknown
          >;
        });

        it('accepts decorated inputs and delegates to its mocked dependency', async () => {
          await instance[method.name](...argsFor(method));

          if (dependencies.length > 0 && method.usesControllerMember) {
            const calls = allMockFunctions(dependencies).filter(
              (fn) => fn.mock.calls.length > 0,
            );
            expect(calls.length).toBeGreaterThan(0);
          }
        });

        it('propagates dependency failures from the controller boundary', async () => {
          if (skipDependencyFailurePropagation.includes(method.name)) {
            return;
          }

          await Promise.resolve()
            .then(() => instance[method.name](...argsFor(method)))
            .catch(() => undefined);
          const called = allMockFunctions(dependencies).find(
            (fn) =>
              fn.mock.calls.length > 0 &&
              !['get', 'getClient'].includes(fn.getMockName()),
          );

          if (!called) {
            return;
          }

          const expected = new Error(
            `${controller.name}.${method.name} failure`,
          );
          called.mockImplementationOnce(() => {
            throw expected;
          });
          await expect(
            Promise.resolve().then(() =>
              instance[method.name](...argsFor(method)),
            ),
          ).rejects.toBe(expected);
        });

        if (method.params.some((param) => param.decorator === 'UploadedFile')) {
          it('accepts a valid uploaded file', async () => {
            await expect(
              instance[method.name](...argsWithFile(method, mockFile())),
            ).resolves.toBeDefined();
          });

          if (method.hasFileGuard) {
            it('rejects a missing uploaded file', async () => {
              await expect(
                instance[method.name](...argsWithFile(method, undefined)),
              ).rejects.toThrow(BadRequestException);
            });
          }

          if (method.hasFileSizeGuard) {
            it('rejects an oversized uploaded file', async () => {
              await expect(
                instance[method.name](
                  ...argsWithFile(
                    method,
                    mockFile({ size: OVERSIZED_FILE_BYTES }),
                  ),
                ),
              ).rejects.toThrow(BadRequestException);
            });
          }

          if (method.hasFileTypeGuard) {
            it('rejects an unsupported uploaded file type', async () => {
              await expect(
                instance[method.name](
                  ...argsWithFile(
                    method,
                    mockFile({ mimetype: 'application/octet-stream' }),
                  ),
                ),
              ).rejects.toThrow(BadRequestException);
            });
          }
        }
      });
    }
  });
}
