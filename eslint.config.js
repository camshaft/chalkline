import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/', '**/dist-node/', '**/node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain JavaScript files run in Node, and the probe's page callbacks run in the browser.
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
