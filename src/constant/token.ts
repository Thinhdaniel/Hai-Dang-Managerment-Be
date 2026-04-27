export const tokenTypes = {
    ACCESS: 'access',
    REFRESH: 'refresh',
    VERIFY_EMAIL: 'verifyEmail',
    RESET_PASSWORD: 'resetPassword',
} as const;

export type TokenType = (typeof tokenTypes)[keyof typeof tokenTypes];
