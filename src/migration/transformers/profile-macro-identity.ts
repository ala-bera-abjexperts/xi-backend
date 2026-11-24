import type { TipTapNode } from './cir-to-tiptap';

const KINDS: Record<string, string> = {
  'profile-picture': 'profilePicture',
  profilepicture: 'profilePicture',
  'user-profile': 'userProfile',
  userprofile: 'userProfile',
  profile: 'userProfile',
};
const ALIASES = [
  'user',
  'username',
  'userkey',
  'userKey',
  'account_id',
  'accountId',
];
type Target = { userId?: string; displayName?: string };

function sourceProfile(node: TipTapNode, allowMapped = false) {
  const attrs = node.attrs ?? {};
  const card = node.type === 'externalMacro';
  const name = card ? attrs.name : attrs.sourceName;
  if (typeof name !== 'string' || !KINDS[name.toLowerCase()]) return null;
  const kind = KINDS[name.toLowerCase()];
  if (
    !card &&
    (node.type !== kind || (!allowMapped && attrs.userId) || attrs.sourceBody)
  )
    return null;
  const params = (card ? attrs.params : attrs.sourceParams) ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params))
    return null;
  if (
    Object.entries(params).some(
      ([key, value]) => !ALIASES.includes(key) || typeof value !== 'string',
    )
  )
    return null;
  // A compatibility card can be edited. Only replace the importer's original placeholder body.
  const placeholder = [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: `${name} (external macro)`,
          marks: [{ type: 'italic' }],
        },
      ],
    },
  ];
  if (
    card &&
    node.content?.length &&
    JSON.stringify(node.content) !== JSON.stringify(placeholder)
  )
    return null;
  return { kind, name, params: params as Record<string, string> };
}

function legacyAliases(node: TipTapNode): string[] {
  if (
    !['profilePicture', 'userProfile'].includes(node.type) ||
    node.attrs?.sourceName ||
    node.attrs?.userId
  )
    return [];
  return [
    ...new Set(
      [node.attrs?.userKey, node.attrs?.userName]
        .filter(
          (value): value is string =>
            typeof value === 'string' && !!value.trim(),
        )
        .map((value) => value.trim()),
    ),
  ];
}

export function hasLegacyProfileMacros(node: TipTapNode): boolean {
  return (
    legacyAliases(node).length > 0 ||
    !!node.content?.some(hasLegacyProfileMacros)
  );
}

/** Patches profile atoms only. Repair never rewrites the page from its source or guesses a person. */
export async function mapProfileMacros(
  doc: TipTapNode,
  lookup: (refs: string[]) => Promise<Map<string, Target>>,
  repairOnly = false,
  confirmedSource?: TipTapNode,
): Promise<TipTapNode> {
  const profiles = new Map<
    TipTapNode,
    NonNullable<ReturnType<typeof sourceProfile>>
  >();
  const collect = (node: TipTapNode) => {
    const profile = sourceProfile(node);
    if (profile) profiles.set(node, profile);
    node.content?.forEach(collect);
  };
  collect(doc);
  if (repairOnly && confirmedSource) {
    const sources: NonNullable<ReturnType<typeof sourceProfile>>[] = [];
    const readSource = (node: TipTapNode) => {
      const profile = sourceProfile(node, true);
      if (profile) sources.push(profile);
      node.content?.forEach(readSource);
    };
    readSource(confirmedSource);
    const legacy: TipTapNode[] = [];
    const readLegacy = (node: TipTapNode) => {
      if (legacyAliases(node).length) legacy.push(node);
      node.content?.forEach(readLegacy);
    };
    readLegacy(doc);
    for (const node of legacy) {
      const refs = legacyAliases(node);
      const matches = sources.filter(
        (source) =>
          source.kind === node.type &&
          refs.every((ref) =>
            Object.values(source.params).some((value) => value.trim() === ref),
          ),
      );
      const duplicates = legacy.filter(
        (other) =>
          other.type === node.type &&
          legacyAliases(other).some((ref) => refs.includes(ref)),
      );
      if (matches.length === 1 && duplicates.length === 1)
        profiles.set(node, matches[0]);
    }
  }
  if (!profiles.size) return doc;
  const refs = [
    ...new Set(
      [...profiles.values()].flatMap((profile) =>
        Object.values(profile.params)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ),
  ];
  const targets = refs.length ? await lookup(refs) : new Map<string, Target>();
  const visit = (node: TipTapNode): TipTapNode => {
    const profile = profiles.get(node);
    if (profile) {
      const aliases = [
        ...new Set(
          Object.values(profile.params)
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ];
      const matches = aliases.map((ref) => targets.get(ref));
      const ids = new Set(matches.map((match) => match?.userId));
      const userId =
        aliases.length && ids.size === 1 ? matches[0]?.userId : undefined;
      if (repairOnly && !userId) return node;
      const names = [
        ...new Set(matches.map((match) => match?.displayName).filter(Boolean)),
      ];
      const displayName =
        names.length === 1 ? names[0] : node.attrs?.userName || aliases[0];
      return {
        type: profile.kind,
        attrs: {
          ...(node.type === profile.kind ? node.attrs : {}),
          ...(userId ? { userId } : {}),
          // Qualify source UUIDs too: they are not proof of a local identity.
          userKey: `confluence:${aliases[0] || 'unresolved'}`.slice(0, 500),
          ...(displayName
            ? { userName: String(displayName).slice(0, 500) }
            : {}),
          sourceName: profile.name,
          sourceParams: profile.params,
          sourceBody: '',
        },
      };
    }
    return node.content ? { ...node, content: node.content.map(visit) } : node;
  };
  return visit(doc);
}
