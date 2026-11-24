import { BadRequestException } from '@nestjs/common';

import {
  checkPlanTicketDates,
  checkTestTicketFields,
  planDayToTicketDate,
  planTextToTicketHtml,
  ticketDateToPlanDay,
  ticketTextForCase,
} from './test-ticket-events';

function codeOf(run: () => void): string | null {
  try {
    run();

    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);

    return ((error as BadRequestException).getResponse() as { code: string })
      .code;
  }
}

describe('checkTestTicketFields', () => {
  const caseKind = 'case_task_type_id' as const;
  const setKind = 'set_task_type_id' as const;

  it('accepts fields a test record can hold', () => {
    expect(
      codeOf(() =>
        checkTestTicketFields(caseKind, {
          summary: '  Login works  ',
          description: '<p>Steps</p>',
          estimatedTime: 10080,
        }),
      ),
    ).toBeNull();
  });

  it('refuses an empty or whitespace summary', () => {
    expect(
      codeOf(() => checkTestTicketFields(setKind, { summary: '   ' })),
    ).toBe('TEST_TITLE_EMPTY');
  });

  it('counts the summary in characters after trimming', () => {
    const emoji = '😀'.repeat(255);

    expect(
      codeOf(() => checkTestTicketFields(caseKind, { summary: ` ${emoji} ` })),
    ).toBeNull();
    expect(
      codeOf(() =>
        checkTestTicketFields(caseKind, { summary: 'a'.repeat(256) }),
      ),
    ).toBe('TEST_TITLE_TOO_LONG');
  });

  it('measures a case description as plain text and a set description as stored', () => {
    const long = `<p>${'a'.repeat(9990)}</p><p>${'b'.repeat(5)}</p>`;

    expect(
      codeOf(() => checkTestTicketFields(caseKind, { description: long })),
    ).toBeNull();
    expect(
      codeOf(() => checkTestTicketFields(setKind, { description: long })),
    ).toBe('TEST_TEXT_TOO_LONG');
  });

  it('refuses a case estimate outside 0..10080 minutes but ignores it for sets', () => {
    expect(
      codeOf(() => checkTestTicketFields(caseKind, { estimatedTime: 10081 })),
    ).toBe('TEST_ESTIMATE_TOO_LARGE');
    expect(
      codeOf(() => checkTestTicketFields(caseKind, { estimatedTime: -1 })),
    ).toBe('TEST_ESTIMATE_TOO_LARGE');
    expect(
      codeOf(() => checkTestTicketFields(caseKind, { estimatedTime: null })),
    ).toBeNull();
    expect(
      codeOf(() => checkTestTicketFields(setKind, { estimatedTime: 99999 })),
    ).toBeNull();
  });

  it('checks a plan summary and measures its description as stored', () => {
    const planKind = 'plan_task_type_id' as const;
    const long = `<p>${'a'.repeat(9990)}</p><p>${'b'.repeat(5)}</p>`;

    expect(
      codeOf(() =>
        checkTestTicketFields(planKind, { summary: 'a'.repeat(256) }),
      ),
    ).toBe('TEST_TITLE_TOO_LONG');
    expect(
      codeOf(() => checkTestTicketFields(planKind, { description: long })),
    ).toBe('TEST_TEXT_TOO_LONG');
    expect(
      codeOf(() => checkTestTicketFields(planKind, { estimatedTime: 99999 })),
    ).toBeNull();
  });
});

describe('ticketTextForCase', () => {
  it('turns rich text into plain text and empty text into null', () => {
    expect(ticketTextForCase('<p>A &amp; B</p><p>C</p>')).toBe('A & B\nC');
    expect(ticketTextForCase('<p></p>')).toBeNull();
    expect(ticketTextForCase(null)).toBeNull();
  });
});

describe('plan ticket dates', () => {
  it('takes the day of the nearest UTC midnight', () => {
    expect(ticketDateToPlanDay('2026-10-27T00:00:00.000Z')).toBe('2026-10-27');
    expect(ticketDateToPlanDay('2026-10-26T18:30:00+00:00')).toBe('2026-10-27');
    expect(ticketDateToPlanDay('2026-10-27T11:24:00Z')).toBe('2026-10-27');
    expect(ticketDateToPlanDay(null)).toBeNull();
    expect(ticketDateToPlanDay('not a date')).toBeNull();
  });

  it('writes a plan day back as UTC midnight', () => {
    expect(planDayToTicketDate('2026-10-31')).toBe('2026-10-31T00:00:00.000Z');
    expect(planDayToTicketDate(null)).toBeNull();
  });

  it('refuses a due date before the start date only', () => {
    expect(
      codeOf(() =>
        checkPlanTicketDates(
          '2026-10-27T00:00:00.000Z',
          '2026-10-26T00:00:00.000Z',
        ),
      ),
    ).toBe('TEST_DATES_ORDER');
    expect(
      codeOf(() =>
        checkPlanTicketDates(
          '2026-10-27T00:00:00.000Z',
          '2026-10-26T18:30:00.000Z',
        ),
      ),
    ).toBeNull();
    expect(
      codeOf(() => checkPlanTicketDates(null, '2026-10-26T00:00:00.000Z')),
    ).toBeNull();
  });
});

describe('planTextToTicketHtml', () => {
  it('turns plain text into escaped paragraphs that read back the same', () => {
    const html = planTextToTicketHtml('Scope <A> & B\nRisks');

    expect(html).toBe('<p>Scope &lt;A&gt; &amp; B</p><p>Risks</p>');
    expect(ticketTextForCase(html)).toBe('Scope <A> & B\nRisks');
    expect(planTextToTicketHtml(null)).toBe('');
  });

  it('hands rich text to the ticket unchanged', () => {
    const html = '<p>Scope <strong>A</strong></p>';

    expect(planTextToTicketHtml(html)).toBe(html);
  });
});
