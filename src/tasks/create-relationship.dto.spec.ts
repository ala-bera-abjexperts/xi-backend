/**
 * @fileoverview Validation tests for CreateRelationshipDto: `target_type`
 * accepts a wiki page (XE-T532 #3) and nothing outside the allow-list.
 * @module src/tasks/create-relationship.dto.spec
 * @author Prince Jadiya
 */

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRelationshipDto } from './dto/create-relationship.dto';

const TARGET = '11111111-1111-4111-8111-111111111111';
const RELATION_TYPE = '22222222-2222-4222-8222-222222222222';

async function targetTypeErrors(targetType: string) {
  const errors = await validate(
    plainToInstance(CreateRelationshipDto, {
      target_id: TARGET,
      target_type: targetType,
      relation_type_id: RELATION_TYPE,
    }),
    { whitelist: true, forbidNonWhitelisted: true },
  );
  return errors.filter((e) => e.property === 'target_type');
}

describe('CreateRelationshipDto target_type', () => {
  it.each(['task', 'process', 'wiki_page'])('accepts %s', async (type) => {
    expect(await targetTypeErrors(type)).toHaveLength(0);
  });

  it.each(['plan_item', 'list', 'wiki'])('rejects %s', async (type) => {
    expect(await targetTypeErrors(type)).toHaveLength(1);
  });
});
