export const MAX_LOG_BYTES = 5 * 1024 * 1024;

const MASK = '***';

// Shorter values would hide ordinary words all over the log.
export const MIN_SECRET_LENGTH = 4;

/** Every form a tool is likely to print a secret in, longest first so one form never leaves part of another. */
function secretForms(secrets: string[]): string[] {
  const forms = new Set<string>();

  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;

    forms.add(secret);
    forms.add(encodeURIComponent(secret));

    const bytes = Buffer.from(secret, 'utf8');

    forms.add(bytes.toString('base64'));
    forms.add(bytes.toString('base64url'));
  }

  return [...forms].sort((a, b) => b.length - a.length);
}

/** Hides secret values in a log. A secret inside a longer base64 block cannot be found this way. */
export function maskSecrets(text: string, secrets: string[]): string {
  return secretForms(secrets).reduce(
    (masked, form) => masked.split(form).join(MASK),
    text,
  );
}

const XML_ESCAPES: [string, string][] = [
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&apos;'],
];

/** Result files are XML, so a secret can also appear in its escaped form. */
export function maskXmlSecrets(text: string, secrets: string[]): string {
  const escaped = secrets.map((secret) =>
    XML_ESCAPES.reduce(
      (value, [from, to]) => value.split(from).join(to),
      secret,
    ),
  );

  return maskSecrets(text, [...secrets, ...escaped]);
}

/** Keeps the end of a long log, where the failure is. Mask first: a cut could split a secret and hide it from the mask. */
export function capLog(text: string, maxBytes = MAX_LOG_BYTES): string {
  const bytes = Buffer.from(text, 'utf8');

  if (bytes.length <= maxBytes) return text;

  const notice = '[earlier output removed: the log was too long]\n';
  const room = Math.max(maxBytes - Buffer.byteLength(notice), 0);
  const tail = bytes.subarray(bytes.length - room).toString('utf8');

  // A cut inside a character leaves a replacement mark; it is dropped with the rest of that line.
  return notice + tail.slice(tail.indexOf('\n') + 1);
}

/** The end of a log, for the error text of a failed run. */
export function lastLines(text: string, count = 200): string {
  return text.split('\n').slice(-count).join('\n');
}
