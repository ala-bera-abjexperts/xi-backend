import { RequestMethod } from '@nestjs/common';
// `PATH_METADATA` / `METHOD_METADATA` are not re-exported from the
// `@nestjs/common` root barrel in the pinned NestJS 11.1.28; they live on the
// `/constants` subpath.
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { runControllerContractSuite } from '../test/controller-contract.helper';
import { WikiLabelsController } from './wiki-labels.controller';

runControllerContractSuite({
  controller: WikiLabelsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('WikiLabelsController route registration', () => {
  const routes = Object.getOwnPropertyNames(WikiLabelsController.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => {
      const handler = (
        WikiLabelsController.prototype as unknown as Record<string, unknown>
      )[name];
      return {
        name,
        path: Reflect.getMetadata(PATH_METADATA, handler as object) as
          | string
          | undefined,
        method: Reflect.getMetadata(METHOD_METADATA, handler as object) as
          | RequestMethod
          | undefined,
      };
    })
    .filter((route) => route.path !== undefined && route.method !== undefined);

  it('registers a PATCH handler for :labelId', () => {
    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ':labelId',
          method: RequestMethod.PATCH,
        }),
      ]),
    );
  });

  it('registers a PUT handler for :labelId', () => {
    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ':labelId',
          method: RequestMethod.PUT,
        }),
      ]),
    );
  });
});

describe('WikiLabelsController legacy compatibility', () => {
  const spaceId = '11111111-1111-4111-8111-111111111111';
  const labelId = '22222222-2222-4222-8222-222222222222';

  function createController() {
    const service = {
      getLabels: jest.fn().mockResolvedValue([{ id: labelId }]),
      getPageLabelAssignmentsForSpace: jest
        .fn()
        .mockResolvedValue([{ page_id: 'page-1', label_id: labelId }]),
      updateLabel: jest.fn().mockResolvedValue({ id: labelId, name: 'Risk' }),
    };

    return {
      controller: new WikiLabelsController(service as never),
      service,
    };
  }

  it('returns legacy flat assignment rows when include_assignments=true', async () => {
    const { controller, service } = createController();

    await expect(controller.list(spaceId, 'true')).resolves.toEqual([
      { page_id: 'page-1', label_id: labelId },
    ]);

    expect(service.getPageLabelAssignmentsForSpace).toHaveBeenCalledWith(
      spaceId,
    );
  });

  it('supports the legacy PUT label update alias', async () => {
    const { controller, service } = createController();

    await expect(
      controller.updateViaPut(spaceId, labelId, { name: 'Risk' }),
    ).resolves.toEqual({ id: labelId, name: 'Risk' });

    expect(service.updateLabel).toHaveBeenCalledWith(labelId, spaceId, {
      name: 'Risk',
    });
  });

  it('keeps the PATCH label update handler', async () => {
    const { controller, service } = createController();

    await expect(
      controller.update(spaceId, labelId, { name: 'Risk' }),
    ).resolves.toEqual({ id: labelId, name: 'Risk' });

    expect(service.updateLabel).toHaveBeenCalledWith(labelId, spaceId, {
      name: 'Risk',
    });
  });
});
