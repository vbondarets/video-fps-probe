module.exports = {
  testEnvironment: 'node',
  transformIgnorePatterns: ['/node_modules/(?!video-fps-probe/)'],
  transform: {
    '\\.[cm]?js$': ['babel-jest', { plugins: ['babel-plugin-transform-import-meta', '@babel/plugin-transform-dynamic-import', '@babel/plugin-transform-modules-commonjs'] }],
  },
};
