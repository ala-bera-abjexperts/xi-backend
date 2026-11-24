import {
  imageUploadsEnabled,
  isOwnImageKey,
  OWN_IMAGE_KEY,
  UPLOAD_IMAGE_CEILING_BYTES,
  USER_IMAGE_FRAMEWORKS,
} from './custom-image-inputs';

describe('USER_IMAGE_FRAMEWORKS', () => {
  it('gives every framework a language and a package to prove it', () => {
    const label = /^[a-z0-9][a-z0-9.+_-]{0,49}$/;

    for (const [name, item] of Object.entries(USER_IMAGE_FRAMEWORKS)) {
      expect(name).toMatch(label);
      expect(item.language).toMatch(label);
      expect(item.packages.length).toBeGreaterThan(0);
    }
  });
});

describe('isOwnImageKey', () => {
  it('is true only for the own image key', () => {
    expect(OWN_IMAGE_KEY).toBe('own-image');
    expect(isOwnImageKey('own-image')).toBe(true);
    expect(isOwnImageKey('playwright')).toBe(false);
    expect(isOwnImageKey(null)).toBe(false);
    expect(isOwnImageKey(undefined)).toBe(false);
  });
});

describe('imageUploadsEnabled', () => {
  it('is on only when set to 1', () => {
    expect(imageUploadsEnabled('1')).toBe(true);
    expect(imageUploadsEnabled('true')).toBe(false);
    expect(imageUploadsEnabled('')).toBe(false);
    expect(imageUploadsEnabled(undefined)).toBe(false);
  });

  it('keeps the upload ceiling at the single-request limit', () => {
    expect(UPLOAD_IMAGE_CEILING_BYTES).toBe(5_242_880_000);
  });
});
