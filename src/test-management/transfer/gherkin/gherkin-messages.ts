import { dialects, Errors } from '@cucumber/gherkin';
import type { GherkinDocument } from '@cucumber/messages';

type Dialect = (typeof dialects)[string];
type Feature = NonNullable<GherkinDocument['feature']>;
type Child = Feature['children'][number];
type Scenario = NonNullable<Child['scenario']>;

export interface GherkinIssue {
  code: string;
  message: string;
  value?: string;
  line?: number;
}

// The library's token errors have no exported class, but both of its wordings are fixed in every language.
const END_OF_FILE =
  /^\(-?\d+:-?\d+\): unexpected end of file, expected: (#\w+(?:, #\w+)*)$/;
const UNEXPECTED_TOKEN =
  /^\(-?\d+:-?\d+\): expected: (#\w+(?:, #\w+)*), got '([\s\S]*)'$/;
const LANGUAGE_LINE = /^\s*#\s*language\s*:\s*(\S+)\s*$/;
const BLANK_OR_COMMENT = /^\s*(#.*)?$/;
const PLACEHOLDER = /<([^\s<>/][^<>]*)>/g;
const WHOLE_PLACEHOLDER = /^<([^\s<>/][^<>]*)>$/;

const VALUE_LENGTH = 80;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/g;

const shown = (value: string): string =>
  value.replace(CONTROL, ' ').trim().slice(0, VALUE_LENGTH);

const hasOwn = (language: string): boolean =>
  Object.keys(dialects).includes(language);

/** The language a text asks for, read like the parser does: before anything but blank lines and comments. */
export function languageOf(lines: string[]): string | undefined {
  for (const line of lines) {
    const language = LANGUAGE_LINE.exec(line)?.[1];

    if (language) return language;
    if (!BLANK_OR_COMMENT.test(line)) return undefined;
  }

  return undefined;
}

/** Language names such as "constructor" would otherwise reach the parser and fail with a raw script error. */
export function unsupportedLanguage(lines: string[]): GherkinIssue | null {
  const language = languageOf(lines);

  return language && !hasOwn(language)
    ? {
        code: 'GHERKIN_LANGUAGE',
        message: `This language is not supported: ${shown(language)}`,
        value: shown(language),
        line: lines.findIndex((l) => LANGUAGE_LINE.test(l)) + 1,
      }
    : null;
}

function startsWithKeyword(text: string, keywords: readonly string[]) {
  return keywords.some((k) => text.startsWith(`${k.trim()}:`));
}

const stepKeywords = (dialect: Dialect): string[] =>
  [...dialect.given, ...dialect.when, ...dialect.then, ...dialect.and]
    .concat(dialect.but)
    .map((k) => k.trim())
    .filter((k) => k !== '*');

/** One code per cause, so the text can be translated; anything unknown says only that the text is not valid. */
export function classifyGherkinError(
  first: unknown,
  language: string | undefined,
): GherkinIssue {
  const dialect = dialects[language && hasOwn(language) ? language : 'en'];
  const raw = first instanceof Error ? first.message : '';
  const end = END_OF_FILE.exec(raw);
  const token = UNEXPECTED_TOKEN.exec(raw);

  if (first instanceof Errors.AstBuilderException) {
    return {
      code: 'GHERKIN_CELLS',
      message:
        'This table row has a different number of cells than the first row',
    };
  }

  if (first instanceof Errors.NoSuchLanguageException) {
    return {
      code: 'GHERKIN_LANGUAGE',
      message: `This language is not supported: ${shown(language ?? '')}`,
      value: shown(language ?? ''),
    };
  }

  if (first instanceof Errors.ParserException) {
    return {
      code: 'GHERKIN_TAG_SPACE',
      message: 'A tag cannot contain spaces; start every tag with @',
    };
  }

  if (end) {
    if (end[1].includes('#DocStringSeparator')) {
      return {
        code: 'GHERKIN_DOCSTRING_OPEN',
        message: 'A doc string is never closed; add the closing quotes line',
      };
    }

    if (end[1].includes('#TagLine')) {
      return {
        code: 'GHERKIN_TAGS_ALONE',
        message:
          'These tags have nothing to apply to; put them directly above a Feature, Rule, Scenario or Examples line',
      };
    }

    return {
      code: 'GHERKIN_UNEXPECTED_END',
      message: 'The text ends too early; a Scenario or step is missing',
    };
  }

  if (token) {
    const [, expected, got] = token;
    const line = got.trim();

    if (expected.includes('#FeatureLine')) {
      return {
        code: 'GHERKIN_FEATURE_MISSING',
        message: `A Feature line was expected here, in the language of the file, but found: ${shown(line)}`,
        value: shown(line),
      };
    }

    if (startsWithKeyword(line, dialect.feature)) {
      return {
        code: 'GHERKIN_EXTRA_FEATURE',
        message:
          'Only one Feature is allowed; remove this line or move it to its own file',
      };
    }

    if (startsWithKeyword(line, dialect.background)) {
      return {
        code: 'GHERKIN_BACKGROUND_PLACE',
        message:
          'A Background must come before the first Scenario, with one per Feature or Rule',
      };
    }

    if (stepKeywords(dialect).includes(line)) {
      return {
        code: 'GHERKIN_STEP_NO_TEXT',
        message: `This step has no text after ${shown(line)}`,
        value: shown(line),
      };
    }

    if (expected.includes('#TagLine') && !expected.includes('#EOF')) {
      return {
        code: 'GHERKIN_TAGS_ALONE',
        message:
          'These tags have nothing to apply to; put them directly above a Feature, Rule, Scenario or Examples line',
      };
    }

    return {
      code: 'GHERKIN_UNEXPECTED_LINE',
      message: `This line does not belong here: ${shown(line)}`,
      value: shown(line),
    };
  }

  return { code: 'GHERKIN_INVALID', message: 'This is not valid Gherkin' };
}

function scenarioIssues(scenario: Scenario, dialect: Dialect): GherkinIssue[] {
  const issues: GherkinIssue[] = [];
  const name = shown(scenario.name);
  const examples = scenario.examples ?? [];
  const isOutline =
    examples.length > 0 || dialect.scenarioOutline.includes(scenario.keyword);
  const columns = new Set(
    examples.flatMap((e) => e.tableHeader?.cells.map((c) => c.value) ?? []),
  );

  if (scenario.steps.length === 0) {
    issues.push({
      code: 'GHERKIN_NO_STEPS',
      message: 'This scenario has no steps',
      line: scenario.location.line,
    });
  }

  if (isOutline && !examples.some((e) => e.tableBody.length > 0)) {
    issues.push({
      code: 'GHERKIN_OUTLINE_NO_ROWS',
      message:
        'This outline has no example rows, so its placeholders are never filled in',
      value: name,
      line: scenario.location.line,
    });
  }

  for (const step of scenario.steps) {
    if (step.text.trim() === '') {
      issues.push({
        code: 'GHERKIN_EMPTY_STEP',
        message: 'This step has no text',
        line: step.location.line,
      });
    }

    // Doc strings often hold markup, and a plain Scenario keeps its text as written.
    if (examples.length === 0) continue;

    const used = [
      ...[...step.text.matchAll(PLACEHOLDER)].map((m) => m[1]),
      ...(step.dataTable?.rows ?? []).flatMap((row) =>
        row.cells.flatMap((c) => {
          const whole = WHOLE_PLACEHOLDER.exec(c.value);

          return whole ? [whole[1]] : [];
        }),
      ),
    ];

    for (const placeholder of new Set(used)) {
      if (!columns.has(placeholder)) {
        issues.push({
          code: 'GHERKIN_PLACEHOLDER_NO_COLUMN',
          message: `The placeholder <${shown(placeholder)}> has no column in Examples`,
          value: `<${shown(placeholder)}>`,
          line: step.location.line,
        });
      }
    }
  }

  // A bare keyword is read as description text, so the step would simply disappear.
  const bare = stepKeywords(dialect);

  scenario.description.split('\n').forEach((text) => {
    if (bare.includes(text.trim())) {
      issues.push({
        code: 'GHERKIN_EMPTY_STEP',
        message: 'This step has no text',
        line: scenario.location.line,
      });
    }
  });

  return issues;
}

/** Advice about a file that parses: it never decides what is imported or exported. */
export function gherkinWarnings(feature: Feature): GherkinIssue[] {
  const dialect = dialects[hasOwn(feature.language) ? feature.language : 'en'];
  const issues: GherkinIssue[] = [];
  let scenarios = 0;

  const walk = (children: readonly Child[]) => {
    for (const child of children) {
      if (child.rule) walk(child.rule.children);

      if (child.scenario) {
        scenarios += 1;
        issues.push(...scenarioIssues(child.scenario, dialect));
      }
    }
  };

  walk(feature.children);

  if (scenarios === 0) {
    issues.push({
      code: 'GHERKIN_NO_SCENARIO',
      message: 'This has no Scenario, so there is nothing to run',
      line: feature.location.line,
    });
  }

  return issues;
}
