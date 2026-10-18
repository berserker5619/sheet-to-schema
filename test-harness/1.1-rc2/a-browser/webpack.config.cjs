const path = require('node:path');
module.exports = {
  mode: 'production',
  target: 'web',
  entry: './src/main.js',
  output: { path: path.resolve(__dirname, 'dist-webpack'), filename: 'main.js', chunkFilename: '[name].[contenthash].js', publicPath: '/', clean: true },
  performance: { hints: false },
};
