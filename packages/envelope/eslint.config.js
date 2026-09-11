// Same parser arrangement as packages/server: Babel parses TS syntax without
// consulting the TypeScript compiler, which typescript-eslint cannot yet do
// against TypeScript 7. `tsc` covers types; this covers everything else.
import babelParser from "@babel/eslint-parser";

export default [
  {
    ignores: ["dist/**", "wasm/**", "node_modules/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: babelParser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: ["@babel/preset-typescript"],
          filename: "file.ts",
        },
      },
    },
  },
];
