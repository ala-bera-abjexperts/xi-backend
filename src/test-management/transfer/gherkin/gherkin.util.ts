import {
  AstBuilder,
  dialects,
  GherkinClassicTokenMatcher,
  Parser,
} from '@cucumber/gherkin';
import {
  IdGenerator,
  type GherkinDocument,
  type Tag,
} from '@cucumber/messages';
import { createHash } from 'crypto';

import { TEST_CASE_LABEL_LIMITS } from '../../common/case-labels';
import { TEST_CASE_LIMITS } from '../../dto/test-case.dto';
import { TEST_TRANSFER_LIMITS } from '../../dto/test-transfer.dto';
import {
  classifyGherkinError,
  gherkinWarnings,
  languageOf,
  unsupportedLanguage,
  type GherkinIssue,
} from './gherkin-messages';

const ISSUE_KEY = /^[A-Z0-9][A-Z0-9_]*-[A-Z]{0,4}\d+$/;
const LINK_TAG = /^(REQ|PRECOND)_/i;
const PRECOND_COMMENT = /^\s*#\s*@PRECOND_(\S+)\s*$/i;
const BLANK_OR_COMMENT = /^\s*(#.*)?$/;

export interface GherkinError {
  line: number;
  message: string;
  code: string;
  value?: string;
}

export interface GherkinBackground {
  name: string;
  line: number;
  definition: string;
  precondKeys: string[];
}

export interface GherkinScenario {
  name: string;
  line: number;

  // The scenario's own tags, where test keys and ids are read from.
  tags: string[];

  // Plain tags of the feature, its Rule and the scenario.
  labels: string[];
  definition: string;
  backgroundIds: number[];
}

export interface ParsedFeature {
  path: string;
  language: string;
  featureName: string;
  featureTags: string[];
  backgrounds: GherkinBackground[];
  scenarios: GherkinScenario[];
  hasRule: boolean;

  // Advice about the file; never decides what is imported or exported.
  lint: GherkinIssue[];
}

export interface ScenarioKeys {
  testKey?: string;
  // Every distinct test key; more than one is an error for the caller.
  testKeys: string[];
  id?: string;
}

type FeatureChild = NonNullable<
  NonNullable<GherkinDocument['feature']>['children']
>[number];

const tagNames = (tags: readonly Tag[]): string[] =>
  tags.map((t) => t.name.replace(/^@/, ''));

const firstLine = (line: number, tags: readonly Tag[]): number =>
  tags.reduce((min, t) => Math.min(min, t.location.line), line);

function prefixedKey(tag: string, prefix: string): string | undefined {
  if (tag.slice(0, prefix.length).toUpperCase() !== prefix) return undefined;

  const key = tag.slice(prefix.length).toUpperCase();

  return ISSUE_KEY.test(key) ? key : undefined;
}

// Plain keys must already be upper case, so tags like @wip-2 stay ordinary tags.
export const isKeyTag = (tag: string): boolean =>
  prefixedKey(tag, 'TEST_') !== undefined ||
  prefixedKey(tag, 'PRECOND_') !== undefined ||
  prefixedKey(tag, 'REQ_') !== undefined ||
  ISSUE_KEY.test(tag) ||
  tag.startsWith('id:');

// Capped at what a case can hold, so a huge feature tag line is not copied into every scenario.
const plainTags = (from: string[], tags: readonly Tag[]): string[] =>
  [...new Set([...from, ...tagNames(tags).filter((t) => !isKeyTag(t))])].slice(
    0,
    TEST_CASE_LABEL_LIMITS.perCase,
  );

export function scenarioKeys(tags: string[]): ScenarioKeys {
  const named = new Set<string>();
  const bare = new Set<string>();
  let id: string | undefined;

  for (const tag of tags) {
    const testKey = prefixedKey(tag, 'TEST_');

    if (testKey) named.add(testKey);
    else if (ISSUE_KEY.test(tag)) {
      // @REQ_CALC-7 looks like a key but names a requirement.
      if (!LINK_TAG.test(tag)) bare.add(tag);
    } else if (tag.startsWith('id:') && id === undefined) {
      id = tag.slice(3) || undefined;
    }
  }

  // @TEST_ names the test on purpose; a bare key beside it may be a defect or a requirement.
  const testKeys = [...(named.size > 0 ? named : bare)];

  return { testKey: testKeys[0], testKeys, id };
}

export function requirementKeys(featureTags: string[]): string[] {
  const keys = featureTags
    .map((tag) => prefixedKey(tag, 'REQ_'))
    .filter((k): k is string => k !== undefined);

  return [...new Set(keys)];
}

export function normalisePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^(\.?\/)+/, '')
    .normalize('NFC');
}

/**
 * Identity of a scenario in the space: destination folder + file path inside the upload + id or title.
 * Cut and hashed when it would not fit the column.
 */
export function featureAutomationKey(
  destination: string,
  path: string,
  idOrTitle: string,
): string {
  const place = destination ? `${destination}/${path}` : path;
  const full = `feature:${place}#${idOrTitle}`;
  const max = TEST_CASE_LIMITS.automationKey;

  if (Buffer.byteLength(full, 'utf8') <= max) return full;

  const suffix = `~${createHash('sha256').update(full).digest('hex').slice(0, 12)}`;
  let cut = '';
  let bytes = 0;

  // Whole code points only, so the cut never splits a character.
  for (const ch of full) {
    const size = Buffer.byteLength(ch, 'utf8');

    if (bytes + size > max - suffix.length) break;

    cut += ch;
    bytes += size;
  }

  return cut + suffix;
}

function parserError(error: unknown, lines: string[]): GherkinError {
  const first =
    error && typeof error === 'object' && 'errors' in error
      ? (error as { errors: unknown[] }).errors[0]
      : error;
  const line =
    first && typeof first === 'object' && 'location' in first
      ? (first as { location?: { line?: number } }).location?.line
      : undefined;

  // An unclosed doc string is reported one line past the end of the text.
  return {
    ...classifyGherkinError(first, languageOf(lines)),
    line: Math.min(line ?? 1, lines.length),
  };
}

function parse(text: string): GherkinDocument {
  const parser = new Parser(
    new AstBuilder(IdGenerator.incrementing()),
    new GherkinClassicTokenMatcher(),
  );

  return parser.parse(text);
}

/** Lines `from`..`to` (1-based), trailing blank and comment lines dropped, common indent removed. */
function slice(
  lines: string[],
  from: number,
  to: number,
  keep: (line: string) => boolean = () => true,
): string[] {
  const block = lines.slice(from - 1, to).filter(keep);

  while (block.length > 0 && BLANK_OR_COMMENT.test(block[block.length - 1])) {
    block.pop();
  }

  // A loop, because spreading a very long scenario into Math.min overflows the stack.
  let indent = Infinity;

  for (const line of block) {
    if (line.trim() !== '') {
      indent = Math.min(
        indent,
        (/^[ \t]*/.exec(line) as RegExpExecArray)[0].length,
      );
    }
  }

  return block.map((l) => (l.trim() === '' ? '' : l.slice(indent)));
}

export function parseFeatureFile(
  text: string,
  path: string,
): ParsedFeature | { error: GherkinError } {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const badLanguage = unsupportedLanguage(lines);

  if (badLanguage) {
    return { error: { ...badLanguage, line: badLanguage.line ?? 1 } };
  }

  let document: GherkinDocument;

  try {
    document = parse(source);
  } catch (error) {
    return { error: parserError(error, lines) };
  }

  const feature = document.feature;

  if (!feature) {
    return {
      error: {
        line: 1,
        code: 'GHERKIN_NO_FEATURE',
        message: 'The file has no Feature',
      },
    };
  }

  const language = feature.language;
  const header = language === 'en' ? [] : [`# language: ${language}`];

  // Every block; it runs from its first line to the line before the next block's first line.
  const blocks: { start: number; line: number }[] = [];
  const collect = (children: readonly FeatureChild[]) => {
    for (const child of children) {
      if (child.background) {
        const line = child.background.location.line;

        blocks.push({ start: line, line });
      }
      if (child.scenario) {
        const { location, tags } = child.scenario;

        blocks.push({
          start: firstLine(location.line, tags),
          line: location.line,
        });
      }
      if (child.rule) {
        const { location, tags } = child.rule;

        blocks.push({
          start: firstLine(location.line, tags),
          line: location.line,
        });
        collect(child.rule.children);
      }
    }
  };

  collect(feature.children);

  if (blocks.length > TEST_TRANSFER_LIMITS.featureBlocks) {
    return {
      error: {
        line: 1,
        code: 'TOO_MANY_BLOCKS',
        message: `The file has more than ${TEST_TRANSFER_LIMITS.featureBlocks} scenarios, rules and backgrounds`,
      },
    };
  }

  blocks.sort((a, b) => a.start - b.start);

  const ends = new Map(
    blocks.map((b, i) => [
      b.line,
      (blocks[i + 1]?.start ?? lines.length + 1) - 1,
    ]),
  );
  const endOf = (line: number): number => ends.get(line) ?? lines.length;
  const comments = new Map(
    document.comments.map((c) => [c.location.line, c.text]),
  );

  const backgrounds: GherkinBackground[] = [];
  const scenarios: GherkinScenario[] = [];

  const addBackground = (
    bg: NonNullable<FeatureChild['background']>,
  ): number => {
    const end = endOf(bg.location.line);
    const precondKeys = new Set<string>();

    for (let line = bg.location.line + 1; line <= end; line++) {
      const key =
        PRECOND_COMMENT.exec(comments.get(line) ?? '')?.[1]?.toUpperCase() ??
        '';

      if (ISSUE_KEY.test(key)) precondKeys.add(key);
    }

    const body = slice(
      lines,
      bg.location.line,
      end,
      (l) => !PRECOND_COMMENT.test(l),
    );

    backgrounds.push({
      name: bg.name,
      line: bg.location.line,
      definition: [...header, ...body].join('\n'),
      precondKeys: [...precondKeys],
    });

    return backgrounds.length - 1;
  };

  // Key tags on these levels are not read, and cut text cannot be seen in the result; each is said once per file.
  const unusedTags = new Set(
    tagNames(feature.tags).filter(
      (t) =>
        prefixedKey(t, 'TEST_') !== undefined ||
        prefixedKey(t, 'PRECOND_') !== undefined,
    ),
  );
  let shortened = false;

  const walk = (
    children: readonly FeatureChild[],
    inherited: number[],
    inheritedTags: string[],
  ) => {
    const own = children.find((c) => c.background)?.background;
    const backgroundIds = own ? [...inherited, addBackground(own)] : inherited;

    for (const child of children) {
      if (child.rule) {
        tagNames(child.rule.tags)
          .filter((t) =>
            ['TEST_', 'REQ_', 'PRECOND_'].some(
              (prefix) => prefixedKey(t, prefix) !== undefined,
            ),
          )
          .forEach((t) => unusedTags.add(t));

        walk(
          child.rule.children,
          backgroundIds,
          plainTags(inheritedTags, child.rule.tags),
        );
      }

      if (!child.scenario) continue;

      const scenario = child.scenario;
      const labels = plainTags(inheritedTags, scenario.tags);

      tagNames(scenario.tags)
        .filter(
          (t) =>
            prefixedKey(t, 'REQ_') !== undefined ||
            prefixedKey(t, 'PRECOND_') !== undefined,
        )
        .forEach((t) => unusedTags.add(t));

      if (
        scenario.name.trim().length > TEST_CASE_LIMITS.title ||
        tagNames(scenario.tags).length + inheritedTags.length >
          TEST_CASE_LABEL_LIMITS.perCase ||
        labels.some((t) => t.length > TEST_CASE_LABEL_LIMITS.length)
      ) {
        shortened = true;
      }

      const body = slice(
        lines,
        scenario.location.line,
        endOf(scenario.location.line),
      );

      scenarios.push({
        name: scenario.name,
        line: scenario.location.line,
        tags: tagNames(scenario.tags),
        labels,
        definition: [
          ...header,
          ...(labels.length > 0 ? [labels.map((t) => `@${t}`).join(' ')] : []),
          ...body,
        ].join('\n'),
        backgroundIds,
      });
    }
  };

  walk(feature.children, [], plainTags([], feature.tags));

  const lint = gherkinWarnings(feature);

  if (unusedTags.size > 0) {
    const tags = [...unusedTags].map((t) => `@${t}`).join(', ');

    lint.push({
      code: 'TAGS_NOT_USED',
      message: `These tags were not used, because they are on the wrong level: ${tags}`,
      value: tags,
    });
  }

  if (shortened) {
    lint.push({
      code: 'TEXT_SHORTENED',
      message:
        'Long scenario names and tags were shortened to fit, and tags past the 50th were left out',
    });
  }

  return {
    path,
    language,
    featureName: feature.name,
    featureTags: tagNames(feature.tags),
    backgrounds,
    scenarios,
    hasRule: feature.children.some((c) => c.rule),
    lint,
  };
}

/** Checks a stored scenario or background by parsing it inside a feature; lines are the definition's own. */
export function validateDefinition(definition: string): GherkinError | null {
  const lines = definition
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const badLanguage = unsupportedLanguage(lines);

  if (badLanguage) return { ...badLanguage, line: badLanguage.line ?? 1 };

  const language = /^\s*#\s*language:\s*(\S+)\s*$/.exec(lines[0] ?? '')?.[1];
  const body = language ? lines.slice(1) : lines;
  const keyword = (language && dialects[language]?.feature[0]) || 'Feature';
  const wrapped = [
    ...(language ? [lines[0]] : []),
    `${keyword}: x`,
    ...body.map((l) => (l === '' ? '' : `  ${l}`)),
  ].join('\n');

  try {
    parse(wrapped);

    return null;
  } catch (error) {
    const found = parserError(error, wrapped.split('\n'));

    // Both layouts add exactly one line in front of the definition's own lines.
    return { ...found, line: Math.max(1, found.line - 1) };
  }
}
