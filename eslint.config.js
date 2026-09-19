import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/', '**/node_modules/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  // Must come last: eslint-config-prettier switches off formatting rules, and `quotes` and
  // `curly` are the two it lets us re-enable (Prettier is configured with singleQuote and
  // never removes braces, so they don't conflict).
  prettier,
  {
    rules: {
      quotes: ['error', 'single', { avoidEscape: true }],
      // Bodies always get braces, so no `if (cond) doThing();` on one line. Prettier
      // (`npm run lint`) then keeps `if (cond) { doThing(); }` from staying on one line.
      curly: ['error', 'all'],
    },
  },
);
