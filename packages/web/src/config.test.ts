import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('the build configuration', () => {
  it('uses relative asset paths, so the page loads from any path it is served at', () => {
    expect(config.base).toBe('./');
  });
});
