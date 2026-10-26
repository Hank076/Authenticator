const path = require("path");
const webpack = require("webpack");
const { VueLoaderPlugin } = require("vue-loader");
const ForkTsCheckerWebpackPlugin = require("fork-ts-checker-webpack-plugin");

module.exports = {
  mode: "development",
  devtool: "source-map",
  entry: {
    "argon-worker": "./src/argon-worker.ts",
    background: "./src/background.ts",
    content: "./src/content.ts",
    popup: "./src/popup.ts",
    import: "./src/import.ts",
    options: "./src/options.ts",
    qrdebug: "./src/qrdebug.ts",
    permissions: "./src/permissions.ts",
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: "ts-loader",
        options: {
          appendTsSuffixTo: [/\.vue$/],
          transpileOnly: true,
        },
        exclude: /node_modules/,
      },
      {
        test: /\.vue$/,
        loader: "vue-loader",
      },
      {
        test: /\.svg$/,
        use: [
          "vue-loader",
          path.resolve(__dirname, "webpack-loaders/vue-svg-loader.js"),
        ],
      },
      {
        // url-loader with no `limit` option defaults to inlining every
        // matched file as a base64 data URL regardless of size (never
        // falls back to a separate emitted file); asset/inline reproduces
        // that exact behavior with webpack 5's built-in asset modules.
        test: /\.(png|jpe?g|gif)$/,
        type: "asset/inline",
      },
    ],
  },
  plugins: [
    new VueLoaderPlugin(),
    // Vue 3 esm-bundler feature flags (better tree-shaking, silences the warning)
    new webpack.DefinePlugin({
      __VUE_OPTIONS_API__: "true",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    }),
    // .vue files are not type-checked here (vue-tsc is not set up);
    // fork-ts-checker's vue extension needs Vue 2's vue-template-compiler.
    new ForkTsCheckerWebpackPlugin(),
  ],
  resolve: {
    extensions: [
      ".mjs",
      ".js",
      ".jsx",
      ".vue",
      ".json",
      ".ts",
      ".tsx",
    ],
    modules: ["node_modules"],
  },
  output: {
    path: path.resolve(__dirname, "js"),
    publicPath: "/js/",
  },
};
