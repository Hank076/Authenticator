const { merge } = require('webpack-merge');
const common = require('./webpack.config.js');

module.exports = merge(common, {
  mode: 'production',
  // The base config enables full source maps for development; don't ship them
  // (and the .map files build.sh copies) in production release artifacts.
  devtool: false,
  // Extension bundles load from disk, not over the network; the web bundle
  // size hints don't apply.
  performance: { hints: false },
});
