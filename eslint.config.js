import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
    { ignores: ['dist', 'node_modules'] },
    {
        extends: [...tseslint.configs.recommended, eslintPluginPrettierRecommended],
        files: ['**/*.ts'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            'no-restricted-syntax': [
                'error',
                {
                    selector:
                        "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(findOneAndUpdate|findByIdAndUpdate|findOneAndReplace|findByIdAndReplace)$/] > ObjectExpression > Property[key.name=/^(new|returnOriginal)$/]",
                    message:
                        "Mongoose 9 deprecates 'new' and 'returnOriginal'. Use returnDocument: 'after' or 'before' instead.",
                },
            ],
        },
    }
);
