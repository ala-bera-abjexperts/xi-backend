import { NotFoundException } from '@nestjs/common';

import { FormBuilderSubmissionsService } from './form-builder-submissions.service';
import { FormBuilderAssignmentsService } from './form-builder-assignments.service';
import { FormBuilderSubmissionEventsService } from './form-builder-submission-events.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('FormBuilderSubmissionsService', () => {
  let service: FormBuilderSubmissionsService;
  let mockFrom: jest.Mock;
  let assignments: { markCompletedOnSubmit: jest.Mock };
  let events: { dispatch: jest.Mock };

  // Chainable Supabase query-builder mock. `count` is surfaced through the awaited
  // result (used by list()); maybeSingle/single resolve the terminal payload.
  function buildChain(resolved: {
    data: unknown;
    error: unknown;
    count?: number;
  }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.neq = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.range = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);

    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    assignments = {
      markCompletedOnSubmit: jest.fn().mockResolvedValue(undefined),
    };
    events = { dispatch: jest.fn().mockResolvedValue(undefined) };

    const supabase = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    service = new FormBuilderSubmissionsService(
      supabase,
      assignments as unknown as FormBuilderAssignmentsService,
      events as unknown as FormBuilderSubmissionEventsService,
    );
  });

  function queue(tableQueues: Record<string, ReturnType<typeof buildChain>[]>) {
    mockFrom.mockImplementation((table: string) => tableQueues[table].shift());
  }

  // a single required short_text field (no calc/conditional logic)
  const shortTextField = {
    field_key: 'q1',
    field_type: 'short_text',
    label: 'Q1',
    required: true,
    is_hidden: false,
    read_only: false,
    options: null,
    validation_rules: {},
    conditional_logic: null,
    calculation: null,
    sort_order: 0,
  };

  describe('list', () => {
    it('returns paginated submitted responses with count and range', async () => {
      const rows = [{ id: 'sub-1' }];
      const chain = buildChain({ data: rows, error: null, count: 1 });

      queue({ form_builder_submissions: [chain] });

      await expect(service.list('form-1', 'space-1', 'org-1')).resolves.toEqual(
        { data: rows, count: 1, page: 1, limit: 50 },
      );

      expect(chain.eq).toHaveBeenCalledWith('form_id', 'form-1');
      expect(chain.eq).toHaveBeenCalledWith('status', 'submitted');
      expect(chain.order).toHaveBeenCalledWith('created_at', {
        ascending: false,
      });
      expect(chain.range).toHaveBeenCalledWith(0, 49);
    });
  });

  describe('create', () => {
    it('validates, snapshots, inserts a submitted response, and fires events', async () => {
      const form = { id: 'form-1', status: 'published', settings: {} };
      const saved = { id: 'sub-1', form_id: 'form-1', status: 'submitted' };

      const formChain = buildChain({ data: form, error: null });
      const fieldsChain = buildChain({ data: [shortTextField], error: null });
      const insertChain = buildChain({ data: saved, error: null });
      const deleteChain = buildChain({ data: null, error: null });

      queue({
        form_builder: [formChain],
        form_builder_fields: [fieldsChain],
        form_builder_submissions: [insertChain, deleteChain],
      });

      await expect(
        service.create(
          'form-1',
          { data: { q1: 'Ada' } } as any,
          'space-1',
          'org-1',
          'user-1',
          { ip: '1.2.3.4', userAgent: 'jest' },
        ),
      ).resolves.toEqual(saved);

      expect(insertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          form_id: 'form-1',
          organization_id: 'org-1',
          space_id: 'space-1',
          submitted_by: 'user-1',
          data: { q1: 'Ada' },
          status: 'submitted',
          version: 1,
          is_test: false,
        }),
      );
      // best-effort side effects for a real (non-draft, non-test) submission
      expect(assignments.markCompletedOnSubmit).toHaveBeenCalledWith(
        'form-1',
        'user-1',
        'sub-1',
        'space-1',
        'org-1',
      );
      expect(events.dispatch).toHaveBeenCalledWith(saved);
    });

    it('throws NotFoundException when the form does not exist', async () => {
      const formChain = buildChain({ data: null, error: null });

      queue({ form_builder: [formChain] });

      await expect(
        service.create(
          'missing',
          { data: {} } as any,
          'space-1',
          'org-1',
          'user-1',
          {},
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects a submission to a form that is not published', async () => {
      const formChain = buildChain({
        data: { id: 'form-1', status: 'draft', settings: {} },
        error: null,
      });

      queue({ form_builder: [formChain] });

      await expect(
        service.create(
          'form-1',
          { data: {} } as any,
          'space-1',
          'org-1',
          'user-1',
          {},
        ),
      ).rejects.toThrow(/not accepting responses/);
    });

    it('throws BadRequestException when a required field is missing', async () => {
      const formChain = buildChain({
        data: { id: 'form-1', status: 'published', settings: {} },
        error: null,
      });
      const fieldsChain = buildChain({ data: [shortTextField], error: null });

      queue({
        form_builder: [formChain],
        form_builder_fields: [fieldsChain],
      });

      await expect(
        service.create(
          'form-1',
          { data: {} } as any,
          'space-1',
          'org-1',
          'user-1',
          {},
        ),
      ).rejects.toThrow(/is required/);
    });
  });

  describe('remove', () => {
    it('deletes the submission and returns success', async () => {
      const chain = buildChain({ data: { id: 'sub-1' }, error: null });

      queue({ form_builder_submissions: [chain] });

      await expect(
        service.remove('sub-1', 'form-1', 'space-1', 'org-1'),
      ).resolves.toEqual({ success: true });

      expect(chain.eq).toHaveBeenCalledWith('id', 'sub-1');
      expect(chain.delete).toHaveBeenCalled();
    });

    it('throws NotFoundException when the submission is missing', async () => {
      const chain = buildChain({ data: null, error: null });

      queue({ form_builder_submissions: [chain] });

      await expect(
        service.remove('missing', 'form-1', 'space-1', 'org-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getDraft', () => {
    it('returns the draft row for the user when present', async () => {
      const draft = { id: 'draft-1', status: 'draft' };
      const chain = buildChain({ data: draft, error: null });

      queue({ form_builder_submissions: [chain] });

      await expect(
        service.getDraft('form-1', 'space-1', 'org-1', 'user-1'),
      ).resolves.toEqual(draft);

      expect(chain.eq).toHaveBeenCalledWith('submitted_by', 'user-1');
      expect(chain.eq).toHaveBeenCalledWith('status', 'draft');
    });

    it('returns null when no draft exists', async () => {
      const chain = buildChain({ data: null, error: null });

      queue({ form_builder_submissions: [chain] });

      await expect(
        service.getDraft('form-1', 'space-1', 'org-1', 'user-1'),
      ).resolves.toBeNull();
    });
  });

  describe('deleteDraft', () => {
    it('deletes the user draft and returns success', async () => {
      const chain = buildChain({ data: null, error: null });

      queue({ form_builder_submissions: [chain] });

      await expect(
        service.deleteDraft('form-1', 'space-1', 'org-1', 'user-1'),
      ).resolves.toEqual({ success: true });

      expect(chain.delete).toHaveBeenCalled();
      expect(chain.eq).toHaveBeenCalledWith('status', 'draft');
    });
  });
});
