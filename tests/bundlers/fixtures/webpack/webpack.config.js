import HtmlWebpackPlugin from 'html-webpack-plugin';

export default {
  mode: 'production',
  entry: './main.js',
  plugins: [new HtmlWebpackPlugin({ template: './template.html' })],
};
