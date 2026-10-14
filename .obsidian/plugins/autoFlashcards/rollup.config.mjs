import typescript from "@rollup/plugin-typescript";

export default {
  input: "main.ts",

  output: {
    dir: ".",
    format: "cjs",
    sourcemap: "inline",
    exports: "default"
  },

  external: [
    "obsidian",
    "electron"
  ],

  plugins: [
    typescript({
      tsconfig: "./tsconfig.json"
    })
  ]
};
