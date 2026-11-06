import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('the build configuration', () => {
  it('uses relative asset paths, so the page loads from any path it is served at', () => {
    expect(config.base).toBe('./');
  });

  it('tells Excalidraw that it runs under React', () => {
    expect(config.define?.['process.env.IS_PREACT']).toBe('"false"');
  });
});
