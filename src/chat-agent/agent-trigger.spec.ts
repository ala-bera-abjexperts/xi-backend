import { extractUserMentionIds } from '../common/utils/mention-extractor';
import { ROBERT_ID } from './agent.constants';
import { isRobertTrigger, RobertTriggerInput } from './agent-trigger';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const base: RobertTriggerInput = {
  kind: 'user',
  authorIsHuman: true,
  mentionIds: [],
  dmKey: null,
};

describe('isRobertTrigger', () => {
  it('starts a run when a human mentions Robert', () => {
    expect(isRobertTrigger({ ...base, mentionIds: [OTHER, ROBERT_ID] })).toBe(
      true,
    );
  });

  it('compares the mention id case-insensitively', () => {
    expect(
      isRobertTrigger({ ...base, mentionIds: [ROBERT_ID.toUpperCase()] }),
    ).toBe(true);
  });

  it('starts a run for every message in a Robert chat, without a mention', () => {
    expect(isRobertTrigger({ ...base, dmKey: `${ROBERT_ID}:${USER}` })).toBe(
      true,
    );
    expect(
      isRobertTrigger({ ...base, dmKey: `${ROBERT_ID}:${USER}`.toUpperCase() }),
    ).toBe(true);
  });

  it('ignores messages without a Robert mention in an ordinary chat', () => {
    expect(isRobertTrigger(base)).toBe(false);
    expect(isRobertTrigger({ ...base, mentionIds: [OTHER] })).toBe(false);
    expect(isRobertTrigger({ ...base, dmKey: `${USER}:${OTHER}` })).toBe(false);
  });

  it('never triggers on system or agent messages', () => {
    for (const kind of ['system', 'agent']) {
      expect(
        isRobertTrigger({
          ...base,
          kind,
          mentionIds: [ROBERT_ID],
          dmKey: `${ROBERT_ID}:${USER}`,
        }),
      ).toBe(false);
    }
  });

  it('never triggers on a non-human author (Robert answering himself)', () => {
    expect(
      isRobertTrigger({
        ...base,
        authorIsHuman: false,
        mentionIds: [ROBERT_ID],
        dmKey: `${ROBERT_ID}:${USER}`,
      }),
    ).toBe(false);
  });

  it('needs the mention node: "@robert" as plain text does not count', () => {
    const html = '<p>@robert what did we agree?</p>';
    expect(
      isRobertTrigger({ ...base, mentionIds: extractUserMentionIds(html) }),
    ).toBe(false);
  });

  it('counts the mention node from the sanitized body', () => {
    const html = `<p><span data-user-mention data-user-id="${ROBERT_ID}" data-user-name="Robert">@Robert</span> hi</p>`;
    expect(
      isRobertTrigger({ ...base, mentionIds: extractUserMentionIds(html) }),
    ).toBe(true);
  });
});
