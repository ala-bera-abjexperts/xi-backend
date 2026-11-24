import { PROGRAMMING_LANGUAGES } from '../languages/programming-languages';

/** The image key of a setting that uses the user's own checked image instead of a server image. */
export const OWN_IMAGE_KEY = 'own-image';

// The table or column isn't there yet: the migration that adds them may not be applied.
export const MISSING_SCHEMA = new Set([
  '42P01',
  '42703',
  'PGRST204',
  'PGRST205',
]);

export function isOwnImageKey(key: string | null | undefined): boolean {
  return key === OWN_IMAGE_KEY;
}

export interface UserImageFramework {
  language: string;
  packages: string[];
}

/** Frameworks the worker can prove are inside an own image, by a package, with their language. */
export const USER_IMAGE_FRAMEWORKS: Record<string, UserImageFramework> = {
  pytest: { language: 'python', packages: ['pytest'] },
  behave: { language: 'python', packages: ['behave'] },
  robot: { language: 'python', packages: ['robotframework'] },
  jest: { language: 'javascript', packages: ['jest'] },
  vitest: { language: 'javascript', packages: ['vitest'] },
  mocha: { language: 'javascript', packages: ['mocha'] },
  playwright: { language: 'javascript', packages: ['@playwright/test'] },
  cypress: { language: 'javascript', packages: ['cypress'] },
  cucumber: { language: 'javascript', packages: ['@cucumber/cucumber'] },
  rspec: { language: 'ruby', packages: ['rspec-core'] },
  minitest: { language: 'ruby', packages: ['minitest'] },
  phpunit: { language: 'php', packages: ['phpunit/phpunit'] },
  pest: { language: 'php', packages: ['pestphp/pest'] },
  gotestsum: { language: 'go', packages: ['gotest.tools/gotestsum'] },
};

export const USER_IMAGE_FRAMEWORK_NAMES = Object.keys(USER_IMAGE_FRAMEWORKS);
export const USER_IMAGE_LANGUAGES = PROGRAMMING_LANGUAGES.map(
  (item) => item.value,
);

/** Trims a text field; an empty box counts as not given. */
export function optionalText({ value }: { value: unknown }): unknown {
  const text = typeof value === 'string' ? value.trim() : value;

  return text === '' ? undefined : text;
}

/** Whether users may upload a docker save file as their custom image. */
export function imageUploadsEnabled(
  raw = process.env.TM_RUNNER_IMAGE_UPLOADS,
): boolean {
  return raw === '1';
}

// The largest file Supabase Storage takes in one request, so the bucket limit can never be set higher.
export const UPLOAD_IMAGE_CEILING_BYTES = 5_242_880_000;
