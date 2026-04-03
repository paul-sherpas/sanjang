export default {
  dev: {
    command: 'node bin/sanjang.js',
    port: 4000,
    portFlag: '--port',
    cwd: '.',
  },
  setup: 'npm install',
  copyFiles: [],
};
