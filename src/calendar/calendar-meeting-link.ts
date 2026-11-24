/**
 * @fileoverview What counts as a meeting link on a calendar entry.
 *
 * The entry dialog applies the same rules; this is the boundary, because the stored link is one other
 * people click. Imported entries do not come through here.
 */

/** Where each named provider's links live. */
export const MEETING_PROVIDER_HOSTS: Record<string, string[]> = {
  teams: [
    'teams.microsoft.com',
    'teams.live.com',
    'teams.cloud.microsoft',
    'teams.microsoft.us',
    'gov.teams.microsoft.us',
  ],
  google_meet: ['meet.google.com'],
  zoom: ['zoom.us', 'zoom.com', 'zoomgov.com'],
};

/** Discord is pasted as a link, never named as a provider, but its links are held to a shape too. */
const DISCORD_HOSTS = ['discord.com', 'discord.gg', 'discordapp.com'];

/**
 * The address shape each service's meeting links take. A link on that service's hosts has to
 * match it, whichever provider the entry names.
 */
export const MEETING_LINK_FORMATS: Record<string, RegExp> = {
  // A room code and nothing after it.
  google_meet: /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/,

  // A join address (`/l/meetup-join/...`) or a short meeting address (`/meet/<number>`).
  teams:
    /^https:\/\/(?:[a-z0-9-]+\.)*teams\.(?:microsoft\.com|live\.com|cloud\.microsoft|microsoft\.us)\/(?:v2\/\?meetingjoin=true#\/)?(?:l\/meetup-join\/\S+|meet\/\d{9,15}(?:\?\S*)?)$/i,

  // A meeting or webinar number, a personal room, or the web client's join address.
  zoom: /^https:\/\/(?:[a-z0-9-]+\.)*(?:zoom\.us|zoom\.com|zoomgov\.com)\/(?:(?:j|w)\/\d{9,11}|my\/[a-z0-9._-]+|wc\/(?:join\/\d{9,11}|\d{9,11}\/join))(?:[?#]\S*)?$/i,

  // An invite, or a channel inside a server (or a direct call).
  discord:
    /^https:\/\/(?:(?:[a-z0-9-]+\.)*discord\.gg\/[a-z0-9-]{2,32}|(?:[a-z0-9-]+\.)*(?:discord\.com|discordapp\.com)\/(?:invite\/[a-z0-9-]{2,32}|channels\/(?:\d{17,20}|@me)\/\d{17,20}(?:\/\d{17,20})?))(?:\?\S*)?$/i,
};

const MEETING_LINK_EXAMPLES: Record<string, string> = {
  google_meet:
    'A Google Meet link must look like https://meet.google.com/abc-defg-hij',
  teams:
    'A Teams link must look like https://teams.microsoft.com/l/meetup-join/… or https://teams.microsoft.com/meet/…',
  zoom: 'A Zoom link must look like https://zoom.us/j/1234567890',
  discord:
    'A Discord link must be an invite (https://discord.gg/…) or a channel link (https://discord.com/channels/…)',
};

const FORMAT_HOSTS: Record<string, string[]> = {
  ...MEETING_PROVIDER_HOSTS,
  discord: DISCORD_HOSTS,
};

/** Services a pasted link may come from; a host missing here is refused. */
export const KNOWN_MEETING_HOSTS = [
  'meet.google.com',
  'teams.microsoft.com',
  'teams.live.com',
  'teams.cloud.microsoft',
  'teams.microsoft.us',
  'gov.teams.microsoft.us',
  'zoom.us',
  'zoom.com',
  'zoomgov.com',
  'webex.com',
  'web.ciscospark.com',
  'gotomeeting.com',
  'goto.com',
  'meet.goto.com',
  'meet.jit.si',
  'whereby.com',
  'bluejeans.com',
  'chime.aws',
  'around.co',
  'meet.lync.com',
  'skype.com',
  'discord.com',
  'discord.gg',
  'discordapp.com',
];

/** Exact host or a subdomain of one, since Zoom and Webex hand out per-tenant hosts. */
function hostMatches(url: URL, hosts: string[]): boolean {
  // A trailing dot is legal spelling of the same host.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');

  return hosts.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

/** Why a link may not be stored as a meeting link, or null when it may. */
export function meetingLinkProblem(
  url: string,
  provider: string | null,
): string | null {
  let parsed: URL;

  try {
    parsed = new URL(url.trim());
  } catch {
    return 'A meeting link must be a full https:// address.';
  }

  if (parsed.protocol !== 'https:') {
    return 'A meeting link must use https://';
  }

  // A link carrying a username and password is the shape phishing takes.
  if (parsed.username !== '' || parsed.password !== '') {
    return 'A meeting link must not contain a username or password.';
  }

  const points =
    parsed.pathname.replace(/\/+$/, '') !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '';

  if (!points) {
    return 'That is the home page of the service, not a meeting link.';
  }

  const named = provider ? MEETING_PROVIDER_HOSTS[provider] : undefined;

  if (named && !hostMatches(parsed, named)) {
    return `That is not a ${provider} link; it should be on ${named[0]}.`;
  }

  // Whatever provider is named, a link on one of these services has to be a meeting address.
  const owner = Object.keys(MEETING_LINK_FORMATS).find((key) =>
    hostMatches(parsed, FORMAT_HOSTS[key]),
  );

  if (owner && !MEETING_LINK_FORMATS[owner].test(url.trim())) {
    return MEETING_LINK_EXAMPLES[owner];
  }

  if (provider === 'custom' && !hostMatches(parsed, KNOWN_MEETING_HOSTS)) {
    return 'That does not look like a meeting link from a known service.';
  }

  return null;
}
