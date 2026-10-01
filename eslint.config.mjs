import globals from "globals";

export default [{
    ignores: [".vscode-test/**", "node_modules/**"],
}, {
    files: ["**/*.js"],
    languageOptions: {
        globals: {
            ...globals.commonjs,
            ...globals.node,
            ...globals.mocha,
        },

        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "no-const-assign": "error",
        "no-this-before-super": "error",
        "no-undef": "error",
        "no-unreachable": "error",
        "no-unused-vars": "error",
        "constructor-super": "error",
        "valid-typeof": "error",
    },
}, {
    files: ["media/**/*.js"],
    languageOptions: { globals: { ...globals.browser, acquireVsCodeApi: "readonly" } },
}];
