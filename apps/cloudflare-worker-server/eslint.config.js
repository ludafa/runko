import base from '../../eslint.config.base.js';

// 全仓共享基线（目前只有「花括号强制」一条），见根目录 eslint.config.base.js。
export default [
  ...base,
  {
    // wrangler dev 的构建产物：每跑一次就多一个 tmp/bundle 目录，
    // 里面是打包后的第三方代码，不是本仓库源码。
    ignores: ['.wrangler/**'],
  },
];
