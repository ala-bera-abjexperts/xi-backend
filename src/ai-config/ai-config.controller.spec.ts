import { GUARDS_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { validate } from 'class-validator';

import { REQUIRE_FEATURE_KEY } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ROLES_KEY } from '../auth/decorators/require-roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AiAutomationModule } from '../ai-automation/ai-automation.module';
import { TenantAiService } from '../ai-automation/tenant-ai.service';
import { runControllerContractSuite } from '../test/controller-contract.helper';
import { AiConfigController } from './ai-config.controller';
import { AiConfigModule } from './ai-config.module';
import { SaveAiConfigDto } from './dto/save-ai-config.dto';
import { TestAiConfigDto } from './dto/test-ai-config.dto';

runControllerContractSuite({
  controller: AiConfigController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('AiConfigController manual behavior', () => {
  const user = {
    userId: 'user-1',
    organizationId: 'org-1',
  };

  function setup() {
    const service = {
      getConfig: jest.fn(),
      saveConfig: jest.fn(),
      deleteConfig: jest.fn(),
      getUsageStats: jest.fn(),
      getModels: jest.fn(),
      testConnection: jest.fn(),
    };
    const controller = new AiConfigController(service as any);
    return { controller, service };
  }

  it('saves config with organization and actor context', () => {
    const { controller, service } = setup();
    const dto = {
      provider_name: 'openai',
      api_key: 'secret',
      model: 'gpt-4.1',
    };

    controller.saveConfig(user as any, dto as any);

    expect(service.saveConfig).toHaveBeenCalledWith('org-1', 'user-1', dto);
  });

  it('reads usage stats for the current organization', () => {
    const { controller, service } = setup();

    controller.getUsageStats(user as any);

    expect(service.getUsageStats).toHaveBeenCalledWith('org-1');
  });

  it('deletes config with organization and actor context', () => {
    const { controller, service } = setup();

    controller.deleteConfig(user as any);

    expect(service.deleteConfig).toHaveBeenCalledWith('org-1', 'user-1');
  });

  it('lists the models of the current organization', async () => {
    const { controller, service } = setup();

    await controller.getModels(user as RequestUser);

    expect(service.getModels).toHaveBeenCalledWith('org-1');
  });

  it('tests the connection with organization and actor context', async () => {
    const { controller, service } = setup();
    const dto: TestAiConfigDto = { model: 'gpt-4.1', api_key: 'secret' };

    await controller.testConnection(user as RequestUser, dto);

    expect(service.testConnection).toHaveBeenCalledWith('org-1', 'user-1', dto);
  });

  it('keeps every route behind the AI licence and the admin/owner role', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AiConfigController)).toEqual([
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, AiConfigController)).toEqual([
      'admin',
      'owner',
    ]);
    expect(
      Reflect.getMetadata(REQUIRE_FEATURE_KEY, AiConfigController),
    ).toEqual(['feature_ai_assist']);

    // No handler replaces the class rules with its own.
    for (const name of Object.getOwnPropertyNames(
      AiConfigController.prototype,
    ).filter((key) => key !== 'constructor')) {
      const handler = (
        AiConfigController.prototype as unknown as Record<string, object>
      )[name];

      expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(REQUIRE_FEATURE_KEY, handler)).toBeUndefined();
    }
  });
});

describe('AiConfigModule', () => {
  it('imports the module that provides the TenantAiService its service needs', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, AiConfigModule),
    ).toContain(AiAutomationModule);
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, AiAutomationModule),
    ).toContain(TenantAiService);
  });
});

describe('AI config DTOs', () => {
  const errorsOf = async (Dto: new () => object, body: object) =>
    (await validate(Object.assign(new Dto(), body))).map((e) => e.property);

  it('accept a save without a key, with a model or with the model cleared', async () => {
    for (const body of [
      { provider_name: 'openai', api_key: 'sk-1' },
      { provider_name: 'openai', model: 'gpt-4.1' },
      { provider_name: 'openai', model: null },
      { provider_name: 'azure_openai', model: 'my_deployment-01' },
      { provider_name: 'openai', model: 'ft:gpt-4o-mini:acme::9abc' },
    ])
      expect(await errorsOf(SaveAiConfigDto, body)).toEqual([]);
  });

  it('refuse a blank key, a missing provider and a model that is not a model name', async () => {
    expect(
      await errorsOf(SaveAiConfigDto, { provider_name: 'openai', api_key: '' }),
    ).toEqual(['api_key']);
    expect(await errorsOf(SaveAiConfigDto, { api_key: 'sk-1' })).toEqual([
      'provider_name',
    ]);

    for (const model of ['', ' ', 'gpt 4', 'x"(404)', 'a'.repeat(129)]) {
      expect(
        await errorsOf(SaveAiConfigDto, { provider_name: 'openai', model }),
      ).toEqual(['model']);
      expect(await errorsOf(TestAiConfigDto, { model })).toEqual(['model']);
    }
  });

  it('accept a connection test with nothing, or with any unsaved value', async () => {
    expect(await errorsOf(TestAiConfigDto, {})).toEqual([]);

    // The frontend service adds the organization id to what it posts; it is ignored, not refused.
    expect(
      await errorsOf(TestAiConfigDto, {
        organizationId: '0b3e7000-0000-4000-8000-000000000001',
      }),
    ).toEqual([]);
    expect(
      await errorsOf(TestAiConfigDto, {
        provider_name: 'mistral',
        api_key: 'key',
        model: 'mistral-small-latest',
      }),
    ).toEqual([]);
    expect(
      await errorsOf(TestAiConfigDto, { provider_name: 'acme', api_key: '' }),
    ).toEqual(['provider_name', 'api_key']);
  });
});
