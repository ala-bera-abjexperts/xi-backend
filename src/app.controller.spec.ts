import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { AppController } from './app.controller';
import { SupabaseAdminService } from './supabase/supabase-admin.service';

describe('AppController', () => {
  let controller: AppController;
  let dbResult: Promise<unknown>;

  beforeEach(async () => {
    dbResult = Promise.resolve({ error: null });
    const chain = {
      from: () => chain,
      select: () => chain,
      limit: () => chain,
      abortSignal: () => dbResult,
    };
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: SupabaseAdminService, useValue: { getClient: () => chain } },
      ],
    }).compile();

    controller = app.get<AppController>(AppController);
  });

  describe('health', () => {
    it('should return status ok', () => {
      const result = controller.getHealth();
      expect(result.status).toBe('ok');
      expect(result.timestamp).toBeDefined();
      expect(typeof result.uptime).toBe('number');
    });
  });

  describe('health/ready', () => {
    it('is ready when the database answers', async () => {
      await expect(controller.getReady()).resolves.toMatchObject({
        status: 'ready',
      });
    });

    it('503s when the database returns an error', async () => {
      dbResult = Promise.resolve({ error: { message: 'down' } });
      await expect(controller.getReady()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('503s when the database call throws (timeout)', async () => {
      dbResult = Promise.reject(new Error('aborted'));
      await expect(controller.getReady()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('503s once shutdown has begun', async () => {
      controller.onModuleDestroy();
      await expect(controller.getReady()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });
});
