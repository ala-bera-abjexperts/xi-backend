import { meetingLinkProblem } from './calendar-meeting-link';

describe('meetingLinkProblem', () => {
  it('accepts a link on its own provider', () => {
    expect(
      meetingLinkProblem('https://zoom.us/j/123456789', 'zoom'),
    ).toBeNull();
    expect(
      meetingLinkProblem('https://meet.google.com/abc-defg-hij', 'google_meet'),
    ).toBeNull();
    expect(
      meetingLinkProblem(
        'https://teams.microsoft.com/l/meetup-join/19%3ameeting',
        'teams',
      ),
    ).toBeNull();
  });

  it('accepts a per-tenant subdomain', () => {
    expect(
      meetingLinkProblem('https://us02web.zoom.us/j/123456789', 'zoom'),
    ).toBeNull();
  });

  it('ignores spaces around the link', () => {
    expect(
      meetingLinkProblem('  https://zoom.us/j/123456789  ', 'zoom'),
    ).toBeNull();
  });

  it('refuses text that is not an address', () => {
    expect(meetingLinkProblem('not a link', 'zoom')).toMatch(/full https/);
  });

  it('refuses http and other schemes', () => {
    expect(meetingLinkProblem('http://zoom.us/j/1', 'zoom')).toMatch(
      /must use https/,
    );
    expect(meetingLinkProblem('ftp://zoom.us/j/1', 'zoom')).toMatch(
      /must use https/,
    );
  });

  it('refuses a link carrying a username or password', () => {
    expect(meetingLinkProblem('https://user:pass@zoom.us/j/1', 'zoom')).toMatch(
      /username or password/,
    );
  });

  it('refuses the home page of a service', () => {
    expect(meetingLinkProblem('https://zoom.us', 'zoom')).toMatch(/home page/);
    expect(meetingLinkProblem('https://zoom.us/', 'zoom')).toMatch(/home page/);
  });

  it('refuses a link on another host than its provider', () => {
    expect(meetingLinkProblem('https://example.com/j/1', 'zoom')).toMatch(
      /not a zoom link/,
    );
    expect(meetingLinkProblem('https://zoom.us/j/1', 'google_meet')).toMatch(
      /not a google_meet link/,
    );
  });

  it('refuses a host that only ends with the provider name', () => {
    expect(meetingLinkProblem('https://notzoom.us/j/1', 'zoom')).toMatch(
      /not a zoom link/,
    );
    expect(meetingLinkProblem('https://zoom.us.evil.test/j/1', 'zoom')).toMatch(
      /not a zoom link/,
    );
  });

  it('takes a pasted link from a known service only', () => {
    expect(
      meetingLinkProblem('https://acme.webex.com/meet/room', 'custom'),
    ).toBeNull();

    for (const link of [
      'https://discord.gg/AbCd1234',
      'https://discord.com/invite/AbCd1234',
      'https://discord.com/channels/123456789012345678/234567890123456789',
      'https://ptb.discord.com/channels/123456789012345678/234567890123456789',
    ]) {
      expect(meetingLinkProblem(link, 'custom')).toBeNull();
    }

    expect(meetingLinkProblem('https://discord.com/', 'custom')).toMatch(
      /home page/,
    );
    expect(meetingLinkProblem('https://notdiscord.com/x', 'custom')).toMatch(
      /known service/,
    );
    expect(meetingLinkProblem('https://discord.gg/AbCd1234', 'zoom')).toMatch(
      /not a zoom link/,
    );
  });

  it('takes a Discord link only as an invite or a channel address', () => {
    const fine = [
      'https://discord.gg/AbCd1234',
      'https://discord.gg/my-server?event=1234567890123456789',
      'https://discord.com/invite/AbCd1234',
      'https://discordapp.com/invite/AbCd1234',
      'https://discord.com/channels/123456789012345678/234567890123456789',
      'https://discord.com/channels/@me/234567890123456789',
      'https://canary.discord.com/channels/123456789012345678/234567890123456789/345678901234567890',
    ];

    const refused = [
      'https://discord.com/download',
      'https://discord.com/app',
      'https://discord.com/channels/1/2',
      'https://discord.com/channels/123456789012345678',
      'https://discord.com/events/123456789012345678/234567890123456789',
      'https://discord.com/invite/',
      'https://discord.gg/a',
    ];

    for (const provider of ['custom', null]) {
      for (const link of fine) {
        expect(meetingLinkProblem(link, provider)).toBeNull();
      }

      for (const link of refused) {
        expect(meetingLinkProblem(link, provider)).toMatch(
          /Discord link must be/,
        );
      }
    }
    expect(meetingLinkProblem('https://example.com/room', 'custom')).toMatch(
      /known service/,
    );
  });

  it('checks only the shape when no provider is named', () => {
    expect(meetingLinkProblem('https://example.com/room', null)).toBeNull();
    expect(meetingLinkProblem('http://example.com/room', null)).toMatch(
      /must use https/,
    );
  });

  it('takes a Google Meet link only as a bare room address', () => {
    const fine = 'https://meet.google.com/abc-defg-hij';

    for (const provider of ['google_meet', 'custom', null]) {
      expect(meetingLinkProblem(fine, provider)).toBeNull();
      expect(meetingLinkProblem(`  ${fine}  `, provider)).toBeNull();
    }

    for (const link of [
      `${fine}?authuser=0`,
      `${fine}/`,
      `${fine}#x`,
      'https://meet.google.com/ABC-defg-hij',
      'https://meet.google.com/abc-defg-hi',
      'https://meet.google.com/abcd-efg-hij',
      'https://meet.google.com/abc-def1-hij',
      'https://meet.google.com/lookup/abc123',
      'https://meet.google.com/new',
      'https://x.meet.google.com/abc-defg-hij',
    ]) {
      for (const provider of ['google_meet', 'custom', null]) {
        expect(meetingLinkProblem(link, provider)).toMatch(
          /Google Meet link must look like/,
        );
      }
    }

    // Other services keep their own, looser rule.
    expect(
      meetingLinkProblem('https://zoom.us/j/123456789?pwd=abc', 'zoom'),
    ).toBeNull();
  });

  it('takes a Teams link only as a join or a short meeting address', () => {
    const fine = [
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d',
      'https://teams.microsoft.com/meet/2941234567890?p=o1AbCdEf',
      'https://teams.live.com/meet/9361234567890',
      'https://gov.teams.microsoft.us/l/meetup-join/19%3ameeting',
      'https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19%3ameeting',
      'https://Teams.Microsoft.com/l/meetup-join/19%3ameeting',
    ];

    const refused = [
      'https://teams.microsoft.com/l/channel/19%3aabc/General',
      'https://teams.microsoft.com/l/meetup-join/',
      'https://teams.microsoft.com/meet/abc',
      'https://teams.microsoft.com/_#/calendarv2',
      'https://teams.microsoft.com/dl/launcher/launcher.html?url=x',
    ];

    for (const provider of ['teams', 'custom', null]) {
      for (const link of fine) {
        expect(meetingLinkProblem(link, provider)).toBeNull();
      }

      for (const link of refused) {
        expect(meetingLinkProblem(link, provider)).toMatch(
          /Teams link must look like/,
        );
      }
    }
  });

  it('takes a Zoom link only as a meeting, personal room or web client address', () => {
    const fine = [
      'https://zoom.us/j/1234567890',
      'https://us02web.zoom.us/j/81234567890?pwd=abcDEF123.1',
      'https://us02web.zoom.us/j/81234567890?pwd=abc#success',
      'https://acme.zoom.us/my/john.doe',
      'https://zoom.us/w/12345678901?tk=abc',
      'https://zoom.us/wc/join/1234567890',
      'https://app.zoom.us/wc/1234567890/join?fromPWA=1',
      'https://www.zoomgov.com/j/1612345678',
    ];

    const refused = [
      'https://zoom.us/j/1',
      'https://zoom.us/j/123456789012',
      'https://zoom.us/j/abcdefghij',
      'https://zoom.us/s/1234567890?zak=token',
      'https://zoom.us/meeting/register/abc',
      'https://zoom.us/profile',
      'https://zoom.us./j/123456789',
    ];

    for (const provider of ['zoom', 'custom', null]) {
      for (const link of fine) {
        expect(meetingLinkProblem(link, provider)).toBeNull();
      }

      for (const link of refused) {
        expect(meetingLinkProblem(link, provider)).toMatch(
          /Zoom link must look like/,
        );
      }
    }
  });
});
