import { rspack } from '@rspack/core';

export default {
  mode: 'production',
  entry: './main.js',
  plugins: [new rspack.HtmlRspackPlugin({ template: './template.html' })],
};
