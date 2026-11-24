/**
 * @fileoverview Clearing a field from the partner portal sends `null`. Nullable
 * columns must accept it (so the clear is saved); NOT NULL columns must reject
 * it with a validation error instead of a DB 500.
 */

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  UpdateLeadDto,
  UpdatePartnerProfileDto,
  UpsertPartnerListingDto,
} from './partner.dto';

async function errorsFor<T extends object>(
  cls: new () => T,
  body: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return errors.map((e) => e.property);
}

describe('partner DTOs: clearing fields', () => {
  it('profile: nullable fields accept null', async () => {
    expect(
      await errorsFor(UpdatePartnerProfileDto, {
        website: null,
        phone: null,
        address_line1: null,
      }),
    ).toEqual([]);
  });

  it('profile: company_name cannot be null or empty, but may be omitted', async () => {
    expect(
      await errorsFor(UpdatePartnerProfileDto, { company_name: null }),
    ).toEqual(['company_name']);
    expect(
      await errorsFor(UpdatePartnerProfileDto, { company_name: '' }),
    ).toEqual(['company_name']);
    expect(await errorsFor(UpdatePartnerProfileDto, { website: 'x' })).toEqual(
      [],
    );
  });

  it('listing: optional fields accept null, social_links does not', async () => {
    expect(
      await errorsFor(UpsertPartnerListingDto, {
        slug: 'abj-experts',
        headline: null,
        website_url: null,
      }),
    ).toEqual([]);
    expect(
      await errorsFor(UpsertPartnerListingDto, {
        slug: 'abj-experts',
        social_links: null,
      }),
    ).toEqual(['social_links']);
  });

  it('lead update: contact fields accept null; company and currency do not', async () => {
    expect(
      await errorsFor(UpdateLeadDto, {
        contact_phone: null,
        request_note: null,
      }),
    ).toEqual([]);
    expect(
      await errorsFor(UpdateLeadDto, { customer_company_name: null }),
    ).toEqual(['customer_company_name']);
    expect(await errorsFor(UpdateLeadDto, { currency: null })).toEqual([
      'currency',
    ]);
    expect(await errorsFor(UpdateLeadDto, {})).toEqual([]);
  });
});
