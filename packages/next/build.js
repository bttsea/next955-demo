// 引入必要的 Node.js 模块和第三方依赖
const path = require('path');
const fs = require('fs-extra');
const chokidar = require('chokidar');
const notifier = require('node-notifier');
const { transformAsync } = require('@babel/core');
const globby = require('globby');
const ncc = require('@zeit/ncc');


// 因为你在 Node.js 17+（你的是 Node.js v18.19.0）环境下使用 ncc（或 Webpack 内部依赖）时，OpenSSL 
// 默认启用了 FIPS 模式或禁用了旧加密算法，导致某些加密调用无法正常运行。
// 方法 1：设置环境变量来绕过加密限制
process.env.NODE_OPTIONS = '--openssl-legacy-provider';




// 工具函数：获取相对路径
const relative = path.relative;

// 定义输出目录
const DIST_DIR = 'dist'; // 编译输出根目录
const COMPILED_DIR = 'compiled'; // NCC 打包输出目录
const POLYFILLS_DIR = 'dist/build/polyfills'; // Polyfills 输出目录

// 通知函数：使用 node-notifier 发送桌面通知
function notify(message, err) {
  try {
    notifier.notify({
      title: err ? 'Next.js 编译错误' : 'Next.js',
      message: err ? err.message : message,
      icon: err ? path.join(__dirname, 'static/error.png') : undefined,
    });
  } catch (notifyErr) {
    console.warn(`通知失败: ${notifyErr.message}`);
  }
}

// 清理目录：删除指定目录及其内容
async function clearDir(dir) {
  const fullPath = path.resolve(__dirname, dir);
  try {
    await fs.access(fullPath);
  } catch {
    console.log(`目录 ${fullPath} 不存在，跳过清理`);
    return;
  }

  let retries = 3;
  while (retries > 0) {
    try {
      await fs.rm(fullPath, { recursive: true, force: true });
      console.log(`已清理 ${fullPath}`);
      return;
    } catch (err) {
      if ((err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'ENOTEMPTY') && retries > 0) {
        console.warn(`清理 ${fullPath} 失败 (${err.code})，等待 500ms 后重试...`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        retries--;
      } else {
        console.error(`清理 ${fullPath} 失败: ${err.message}`);
        throw err;
      }
    }
  }
  throw new Error(`清理 ${fullPath} 失败，超过最大重试次数`);
}

// 复制文件：将源文件复制到目标路径
// 复制文件
async function copyFiles(srcGlob, destDir) {
  try {
    const normalizedGlob = srcGlob.replace(/\\/g, '/');
    const files = await globby(normalizedGlob, {
      cwd: __dirname,
      absolute: false,
      dot: true,
      onlyFiles: false,
    });

    if (files.length === 0) {
      console.warn(`警告: 没有匹配到 ${normalizedGlob} 的文件`);
      return;
    }

    for (const file of files) {
      const src = path.join(__dirname, file);
      // 提取相对于 srcGlob 的路径，移除顶层目录（如 compiled/、bin/、build/）
      const relativePath = path
        .relative(path.dirname(normalizedGlob), file)
        .replace(/\\/g, '/')
        .replace(/^compiled\//, '')
        .replace(/^bin\//, '')
        .replace(/^build\//, '')
        .replace(/^next-server\//, '');
      const dest = path.join(__dirname, destDir, relativePath);

      if (!(await fs.pathExists(src))) {
        console.warn(`跳过不存在的源文件: ${src}`);
        continue;
      }

      await fs.ensureDir(path.dirname(dest));
      let retries = 3;
      while (retries > 0) {
        try {
          await fs.copy(src, dest, { overwrite: true });
          console.log(`已复制 ${file} 到 ${dest}`);
          break;
        } catch (err) {
          if (err.code === 'EBUSY' && retries > 0) {
            console.warn(`文件忙碌 (${file})，等待 500ms 后重试...`);
            await new Promise((resolve) => setTimeout(resolve, 500));
            retries--;
          } else {
            console.error(`复制 ${file} 失败: ${err.message}`);
            throw err;
          }
        }
      }
    }
  } catch (err) {
    console.error(`复制文件失败 (${srcGlob}): ${err.message}`);
    throw err;
  }
}

// Babel 配置：客户端环境
const babelClientOpts = {
  presets: [
    '@babel/preset-typescript',
    [
      '@babel/preset-env',
      {
        modules: 'commonjs',
        targets: {
          esmodules: true,
        },
        bugfixes: true,
        loose: true,
        exclude: [
          'transform-typeof-symbol',
          'transform-async-to-generator',
          'transform-spread',
        ],
      },
    ],
    ['@babel/preset-react', { useBuiltIns: true }],
  ],
  plugins: [
    '@babel/plugin-syntax-dynamic-import',
    ['@babel/plugin-proposal-class-properties', { loose: true }],
  ],
  overrides: [
    {
      test: /\.tsx?$/,
      plugins: [require('@babel/plugin-proposal-numeric-separator').default],
    },
  ],
};

// Babel 配置：服务器端环境
const babelServerOpts = {
  presets: [
    '@babel/preset-typescript',
    ['@babel/preset-react', { useBuiltIns: true }],
    [
      '@babel/preset-env',
      {
        modules: 'commonjs',
        targets: {
          node: '8.3', // Next.js 9.5.5 支持 Node.js 8.3，但运行时为 Node.js 18
        },
        loose: true,
        exclude: [
          'transform-typeof-symbol',
          'transform-async-to-generator',
          'transform-spread',
        ],
      },
    ],
  ],
  plugins: [
    'babel-plugin-dynamic-import-node',
    ['@babel/plugin-proposal-class-properties', { loose: true }],
  ],
  overrides: [
    {
      test: /\.tsx?$/,
      plugins: [require('@babel/plugin-proposal-numeric-separator').default],
    },
  ],
};

// 设置 Next.js 版本：替换代码中的 process.env.__NEXT_VERSION
function setNextVersion(code) {
  const version = require('./package.json').version;
  return code.replace(/process\.env\.__NEXT_VERSION/g, `"${version}"`);
}

// Babel 编译函数：处理单个文件或 glob 模式的编译
async function compileWithBabel(src, dest, env = 'server', opts = {}) {
  const isClient = env === 'client';
  const babelOpts = isClient ? babelClientOpts : babelServerOpts;

  // 使用 globby 获取匹配的文件
  const files = await globby(src, { cwd: __dirname, absolute: true });

  if (files.length === 0) {
    console.warn(`警告: 没有匹配到 ${src} 的文件`);
    return;
  }

  for (const filePath of files) {
    // 跳过 .d.ts 文件
    if (filePath.endsWith('.d.ts')) {
      console.log(`跳过 .d.ts 文件: ${filePath}`);
      continue;
    }

    try {
      const fileContent = await fs.readFile(filePath, 'utf8');
      // 计算目标路径，移除顶层目录（如 build/、next-server/）
      const relativePath = path
        .relative(__dirname, filePath)
        .replace(/^build\//, '')
        .replace(/^next-server\//, '')
        .replace(/^client\//, '')
        .replace(/^server\//, '');
      let outputFile = path.join(__dirname, dest, relativePath);

      // 处理文件扩展名
      const ext = path.extname(filePath);
      if (ext) {
        const extRegex = new RegExp(ext.replace('.', '\\.') + '$', 'i');
        outputFile = outputFile.replace(extRegex, opts.stripExtension ? '' : '.js');
      }

      const distDir = path.dirname(outputFile);
      const filename = path.basename(filePath);

      const options = {
        ...babelOpts,
        plugins: [
          ...babelOpts.plugins,
          isClient
            ? [
                '@babel/plugin-transform-runtime',
                {
                  corejs: false,
                  helpers: true,
                  regenerator: false,
                  useESModules: false,
                },
              ]
            : false,
        ].filter(Boolean),
        compact: true,
        babelrc: false,
        configFile: false,
        cwd: __dirname,
        filename,
        sourceFileName: path.relative(distDir, filePath),
        sourceMaps: true,
      };

      // 执行 Babel 编译
      const output = await transformAsync(fileContent, options);
      let outputCode = output.code;

      // 处理 next-dev.js 的 noop.js 导入
      if (filename === 'next-dev.js') {
        outputCode = outputCode.replace(
          /__REPLACE_NOOP_IMPORT__/g,
          `import('./dev/noop');`
        );
      }

      // 替换版本号（确保 setNextVersion 已定义）
      outputCode = typeof setNextVersion === 'function'
        ? setNextVersion(outputCode)
        : outputCode;

      // 写入编译后的代码
      await fs.ensureDir(distDir);
      let retries = 3;
      while (retries > 0) {
        try {
          await fs.writeFile(outputFile, outputCode);
          break;
        } catch (err) {
          if (err.code === 'EBUSY' && retries > 0) {
            console.warn(`写入 ${outputFile} 失败 (EBUSY)，等待 500ms 后重试...`);
            await new Promise((resolve) => setTimeout(resolve, 500));
            retries--;
          } else {
            throw err;
          }
        }
      }

      // 写入 source map
      if (output.map) {
        const mapFile = `${outputFile}.map`;
        await fs.writeFile(mapFile, JSON.stringify(output.map));
        await fs.appendFile(outputFile, `\n//# sourceMappingURL=${path.basename(mapFile)}`);
      }

      console.log(`已编译 ${filePath} 到 ${outputFile}`);
    } catch (err) {
      console.error(`编译 ${filePath} 失败: ${err.message}`);
      throw err;
    }
  }

  // 通知编译完成（确保 notify 已定义）
  if (typeof notify === 'function') {
    notify(`已编译 ${src} 文件到 ${dest}`);
  } else {
    console.log(`已编译 ${src} 文件到 ${dest}`);
  }
}



 

/**** */
// 生成 package.json 和 LICENSE 文件// 生成 package.json 和 LICENSE 文件
async function writePackageManifest(packageName, main, targetDir) {
  await fs.ensureDir(targetDir);
  if (!packageName) {
    console.log(`跳过 package.json 生成，packageName 未提供`);
    return;
  }

  let packagePath;
  try {
    packagePath = require.resolve(`${packageName}/package.json`, {
      paths: [
        __dirname,
        process.cwd(),
        path.join(__dirname, '../../'),
        path.join(__dirname, '../../node_modules'), // 添加 node_modules 路径
      ],
    });
    console.log(`找到 ${packageName}/package.json: ${packagePath}`);
  } catch (err) {
    console.warn(`警告: 无法找到 ${packageName}/package.json，跳过 package.json 和 LICENSE 生成 (${err.message})`);
    return;
  }

  let packageData;
  try {
    packageData = require(packagePath);
  } catch (err) {
    console.warn(`警告: 无法加载 ${packageName}/package.json，跳过 package.json 和 LICENSE 生成 (${err.message})`);
    return;
  }

  const { name, author, license } = packageData;
  const compiledPackagePath = targetDir;

  const licensePaths = [
    path.join(path.dirname(packagePath), 'LICENSE'),
    path.join(path.dirname(packagePath), 'license'),
  ];
  for (const licensePath of licensePaths) {
    if (await fs.pathExists(licensePath)) {
      await fs.copy(licensePath, path.join(compiledPackagePath, 'LICENSE'));
      console.log(`已复制 LICENSE 到 ${compiledPackagePath}`);
      break;
    }
  }

  const packageJson = {
    name,
    main: path.basename(main, path.extname(main)),
    ...(author ? { author } : {}),
    ...(license ? { license } : {}),
  };
  await fs.writeFile(
    path.join(compiledPackagePath, 'package.json'),
    JSON.stringify(packageJson, null, 2) + '\n'
  );
  console.log(`已生成 package.json 到 ${compiledPackagePath}`);
}


// NCC 打包：使用 @zeit/ncc@0.22.0
async function compileWithNcc(packageName, src, target, externals = {}) {
  // 确保目标目录存在
  await fs.ensureDir(target);

  const nccExternals = { ...externals };
  if (packageName && nccExternals[packageName]) {
    delete nccExternals[packageName];
  }

  // 执行 NCC 打包
  try {
    const { code, assets } = await ncc(src, {
      filename: path.basename(src),
      minify: true,
      externals: Object.keys(nccExternals),
    });

    // 处理 assets
    const outputFiles = [];
    for (const [key, asset] of Object.entries(assets)) {
      let data = asset.source;
      if (key.endsWith('terser-webpack-plugin/dist/minify.js')) {
        data = data
          .toString()
          .replace(`require('terser')`, `require("${externals['terser']}")`);
      }
      outputFiles.push({
        dir: path.join(target, path.dirname(key)),
        base: path.basename(key),
        data: Buffer.from(data),
      });
    }

    // 生成 package.json 和 LICENSE
    if (packageName) {
      await writePackageManifest(packageName, path.basename(src), target);
    }

    // 添加主输出文件
    outputFiles.push({
      dir: target,
      base: path.basename(src),
      data: Buffer.from(code, 'utf8'),
    });

    // 写入所有文件
    for (const file of outputFiles) {
      await fs.ensureDir(file.dir);
      await fs.writeFile(path.join(file.dir, file.base), file.data);
      console.log(`已写入 NCC 文件: ${path.join(file.dir, file.base)}`);
    }

    console.log(`已打包 ${packageName || path.basename(src)} 到 ${target}`);
  } catch (err) {
    console.error(`NCC 打包失败 (${packageName || src}): ${err.message}`);
    throw err;
  }
}

 
 







// Polyfill 任务：处理浏览器兼容性相关的 polyfill 文件
async function nextPolyfillNomodule() {
  const src = relative(__dirname, require.resolve('@next/polyfill-nomodule'));
  await copyFiles(src, path.join(POLYFILLS_DIR, 'nomodule.js'));
}

async function unfetch() {
  const src = relative(__dirname, require.resolve('unfetch'));
  await copyFiles(src, path.join(POLYFILLS_DIR, 'unfetch.js'));
}

async function browserPolyfills() {
  await Promise.all([nextPolyfillNomodule(), unfetch()]);
}

// 复制 NCC 打包结果：确保 compiled 目录存在
async function copyNcced() {
  const srcDir = path.join(__dirname, 'compiled');
  const destDir = path.join(__dirname, 'dist', 'compiled');

  // 检查 compiled 目录是否存在
  if (!(await fs.pathExists(srcDir))) {
    console.warn('compiled 目录不存在，跳过复制');
    return;
  }

  // 使用更具体的 glob 模式
  await copyFiles('compiled/**/*', 'dist/compiled');
}

// 定义 NCC 外部依赖映射
const externals = {
  '@babel/core': '@babel/core',
  browserslist: 'browserslist',
  'caniuse-lite': 'caniuse-lite',
  webpack: 'webpack',
  'webpack-sources': 'webpack-sources',
  'webpack/lib/node/NodeOutputFileSystem': 'webpack/lib/node/NodeOutputFileSystem',
  'webpack/lib/cache/getLazyHashedEtag': 'webpack/lib/cache/getLazyHashedEtag',
  'webpack/lib/RequestShortener': 'webpack/lib/RequestShortener',
  chokidar: 'chokidar',
  'find-cache-dir': 'find-cache-dir',
  'loader-runner': 'loader-runner',
  'loader-utils': 'loader-utils',
  mkdirp: 'mkdirp',
  'neo-async': 'neo-async',
  'schema-utils': 'schema-utils',
  'jest-worker': 'jest-worker',
  cacache: 'cacache',
};

// NCC 打包任务：为每个外部依赖定义单独的打包函数
async function nccAmphtmlValidator() {
  externals['amphtml-validator'] = 'next/dist/compiled/amphtml-validator';
  await compileWithNcc(
    'amphtml-validator',
    require.resolve('amphtml-validator'),
    path.join(COMPILED_DIR, 'amphtml-validator'),
    externals
  );
}

async function nccArg() {
  externals['arg'] = 'next/dist/compiled/arg';
  await compileWithNcc(
    'arg',
    require.resolve('arg'),
    path.join(COMPILED_DIR, 'arg'),
    externals
  );
}

async function nccAsyncRetry() {
  externals['async-retry'] = 'next/dist/compiled/async-retry';
  await compileWithNcc(
    'async-retry',
    require.resolve('async-retry'),
    path.join(COMPILED_DIR, 'async-retry'),
    externals
  );
}

async function nccAsyncSema() {
  externals['async-sema'] = 'next/dist/compiled/async-sema';
  await compileWithNcc(
    'async-sema',
    require.resolve('async-sema'),
    path.join(COMPILED_DIR, 'async-sema'),
    externals
  );
}

async function nccBabelLoader() {
  externals['babel-loader'] = 'next/dist/compiled/babel-loader';
  await compileWithNcc(
    'babel-loader',
    require.resolve('babel-loader'),
    path.join(COMPILED_DIR, 'babel-loader'),
    externals
  );
}

async function nccCacheLoader() {
  externals['cache-loader'] = 'next/dist/compiled/cache-loader';
  await compileWithNcc(
    'cache-loader',
    require.resolve('cache-loader'),
    path.join(COMPILED_DIR, 'cache-loader'),
    externals
  );
}

async function nccChalk() {
  externals['chalk'] = 'next/dist/compiled/chalk';
  await compileWithNcc(
    'chalk',
    require.resolve('chalk'),
    path.join(COMPILED_DIR, 'chalk'),
    externals
  );
}

async function nccCiInfo() {
  externals['ci-info'] = 'next/dist/compiled/ci-info';
  await compileWithNcc(
    'ci-info',
    require.resolve('ci-info'),
    path.join(COMPILED_DIR, 'ci-info'),
    externals
  );
}

async function nccCompression() {
  externals['compression'] = 'next/dist/compiled/compression';
  await compileWithNcc(
    'compression',
    require.resolve('compression'),
    path.join(COMPILED_DIR, 'compression'),
    externals
  );
}

async function nccConf() {
  externals['conf'] = 'next/dist/compiled/conf';
  await compileWithNcc(
    'conf',
    require.resolve('conf'),
    path.join(COMPILED_DIR, 'conf'),
    externals
  );
}

async function nccContentType() {
  externals['content-type'] = 'next/dist/compiled/content-type';
  await compileWithNcc(
    'content-type',
    require.resolve('content-type'),
    path.join(COMPILED_DIR, 'content-type'),
    externals
  );
}

async function nccCookie() {
  externals['cookie'] = 'next/dist/compiled/cookie';
  await compileWithNcc(
    'cookie',
    require.resolve('cookie'),
    path.join(COMPILED_DIR, 'cookie'),
    externals
  );
}

async function nccDebug() {
  externals['debug'] = 'next/dist/compiled/debug';
  await compileWithNcc(
    'debug',
    require.resolve('debug'),
    path.join(COMPILED_DIR, 'debug'),
    externals
  );
}

async function nccDevalue() {
  externals['devalue'] = 'next/dist/compiled/devalue';
  await compileWithNcc(
    'devalue',
    require.resolve('devalue'),
    path.join(COMPILED_DIR, 'devalue'),
    externals
  );
}

async function nccEscapeStringRegexp() {
  externals['escape-string-regexp'] = 'next/dist/compiled/escape-string-regexp';
  await compileWithNcc(
    'escape-string-regexp',
    require.resolve('escape-string-regexp'),
    path.join(COMPILED_DIR, 'escape-string-regexp'),
    externals
  );
}

async function nccEtag() {
  externals['etag'] = 'next/dist/compiled/etag';
  await compileWithNcc(
    'etag',
    require.resolve('etag'),
    path.join(COMPILED_DIR, 'etag'),
    externals
  );
}

async function nccFileLoader() {
  externals['file-loader'] = 'next/dist/compiled/file-loader';
  await compileWithNcc(
    'file-loader',
    require.resolve('file-loader'),
    path.join(COMPILED_DIR, 'file-loader'),
    externals
  );
}

async function nccFindUp() {
  externals['find-up'] = 'next/dist/compiled/find-up';
  await compileWithNcc(
    'find-up',
    require.resolve('find-up'),
    path.join(COMPILED_DIR, 'find-up'),
    externals
  );
}

async function nccFresh() {
  externals['fresh'] = 'next/dist/compiled/fresh';
  await compileWithNcc(
    'fresh',
    require.resolve('fresh'),
    path.join(COMPILED_DIR, 'fresh'),
    externals
  );
}

async function nccGzipSize() {
  externals['gzip-size'] = 'next/dist/compiled/gzip-size';
  await compileWithNcc(
    'gzip-size',
    require.resolve('gzip-size'),
    path.join(COMPILED_DIR, 'gzip-size'),
    externals
  );
}

async function nccHttpProxy() {
  externals['http-proxy'] = 'next/dist/compiled/http-proxy';
  await compileWithNcc(
    'http-proxy',
    require.resolve('http-proxy'),
    path.join(COMPILED_DIR, 'http-proxy'),
    externals
  );
}

async function nccIgnoreLoader() {
  externals['ignore-loader'] = 'next/dist/compiled/ignore-loader';
  await compileWithNcc(
    'ignore-loader',
    require.resolve('ignore-loader'),
    path.join(COMPILED_DIR, 'ignore-loader'),
    externals
  );
}

async function nccIsDocker() {
  externals['is-docker'] = 'next/dist/compiled/is-docker';
  await compileWithNcc(
    'is-docker',
    require.resolve('is-docker'),
    path.join(COMPILED_DIR, 'is-docker'),
    externals
  );
}

async function nccIsWsl() {
  externals['is-wsl'] = 'next/dist/compiled/is-wsl';
  await compileWithNcc(
    'is-wsl',
    require.resolve('is-wsl'),
    path.join(COMPILED_DIR, 'is-wsl'),
    externals
  );
}

async function nccJson5() {
  externals['json5'] = 'next/dist/compiled/json5';
  await compileWithNcc(
    'json5',
    require.resolve('json5'),
    path.join(COMPILED_DIR, 'json5'),
    externals
  );
}

async function nccJsonwebtoken() {
  externals['jsonwebtoken'] = 'next/dist/compiled/jsonwebtoken';
  await compileWithNcc(
    'jsonwebtoken',
    require.resolve('jsonwebtoken'),
    path.join(COMPILED_DIR, 'jsonwebtoken'),
    externals
  );
}

async function nccLodashCurry() {
  externals['lodash.curry'] = 'next/dist/compiled/lodash.curry';
  await compileWithNcc(
    'lodash.curry',
    require.resolve('lodash.curry'),
    path.join(COMPILED_DIR, 'lodash.curry'),
    externals
  );
}

async function nccLruCache() {
  externals['lru-cache'] = 'next/dist/compiled/lru-cache';
  await compileWithNcc(
    'lru-cache',
    require.resolve('lru-cache'),
    path.join(COMPILED_DIR, 'lru-cache'),
    externals
  );
}

async function nccNanoid() {
  externals['nanoid'] = 'next/dist/compiled/nanoid';
  await compileWithNcc(
    'nanoid',
    require.resolve('nanoid'),
    path.join(COMPILED_DIR, 'nanoid'),
    externals
  );
}

async function nccNodeFetch() {
  externals['node-fetch'] = 'next/dist/compiled/node-fetch';
  await compileWithNcc(
    'node-fetch',
    require.resolve('node-fetch'),
    path.join(COMPILED_DIR, 'node-fetch'),
    externals
  );
}

async function nccOra() {
  externals['ora'] = 'next/dist/compiled/ora';
  await compileWithNcc(
    'ora',
    require.resolve('ora'),
    path.join(COMPILED_DIR, 'ora'),
    externals
  );
}

async function nccPostcssFlexbugsFixes() {
  externals['postcss-flexbugs-fixes'] = 'next/dist/compiled/postcss-flexbugs-fixes';
  await compileWithNcc(
    'postcss-flexbugs-fixes',
    require.resolve('postcss-flexbugs-fixes'),
    path.join(COMPILED_DIR, 'postcss-flexbugs-fixes'),
    externals
  );
}

async function nccPostcssLoader() {
  externals['postcss-loader'] = 'next/dist/compiled/postcss-loader';
  await compileWithNcc(
    'postcss-loader',
    require.resolve('postcss-loader'),
    path.join(COMPILED_DIR, 'postcss-loader'),
    externals
  );
}

async function nccPostcssPresetEnv() {
  externals['postcss-preset-env'] = 'next/dist/compiled/postcss-preset-env';
  await compileWithNcc(
    'postcss-preset-env',
    require.resolve('postcss-preset-env'),
    path.join(COMPILED_DIR, 'postcss-preset-env'),
    externals
  );
}

async function nccRawBody() {
  externals['raw-body'] = 'next/dist/compiled/raw-body';
  await compileWithNcc(
    'raw-body',
    require.resolve('raw-body'),
    path.join(COMPILED_DIR, 'raw-body'),
    externals
  );
}

async function nccRecast() {
  externals['recast'] = 'next/dist/compiled/recast';
  await compileWithNcc(
    'recast',
    require.resolve('recast'),
    path.join(COMPILED_DIR, 'recast'),
    externals
  );
}

async function nccResolve() {
  externals['resolve'] = 'next/dist/compiled/resolve';
  await compileWithNcc(
    'resolve',
    require.resolve('resolve'),
    path.join(COMPILED_DIR, 'resolve'),
    externals
  );
}

async function nccSend() {
  externals['send'] = 'next/dist/compiled/send';
  await compileWithNcc(
    'send',
    require.resolve('send'),
    path.join(COMPILED_DIR, 'send'),
    externals
  );
}

async function nccSourceMap() {
  externals['source-map'] = 'next/dist/compiled/source-map';
  await compileWithNcc(
    'source-map',
    require.resolve('source-map'),
    path.join(COMPILED_DIR, 'source-map'),
    externals
  );
}

async function nccStringHash() {
  externals['string-hash'] = 'next/dist/compiled/string-hash';
  await compileWithNcc(
    'string-hash',
    require.resolve('string-hash'),
    path.join(COMPILED_DIR, 'string-hash'),
    externals
  );
}

async function nccStripAnsi() {
  externals['strip-ansi'] = 'next/dist/compiled/strip-ansi';
  await compileWithNcc(
    'strip-ansi',
    require.resolve('strip-ansi'),
    path.join(COMPILED_DIR, 'strip-ansi'),
    externals
  );
}

async function nccTerser() {
  externals['terser'] = 'next/dist/compiled/terser';
  await compileWithNcc(
    'terser',
    require.resolve('terser'),
    path.join(COMPILED_DIR, 'terser'),
    externals
  );
}

async function nccTextTable() {
  externals['text-table'] = 'next/dist/compiled/text-table';
  await compileWithNcc(
    'text-table',
    require.resolve('text-table'),
    path.join(COMPILED_DIR, 'text-table'),
    externals
  );
}

async function nccThreadLoader() {
  externals['thread-loader'] = 'next/dist/compiled/thread-loader';
  await compileWithNcc(
    'thread-loader',
    require.resolve('thread-loader'),
    path.join(COMPILED_DIR, 'thread-loader'),
    externals
  );
}

async function nccUnistore() {
  externals['unistore'] = 'next/dist/compiled/unistore';
  await compileWithNcc(
    'unistore',
    require.resolve('unistore'),
    path.join(COMPILED_DIR, 'unistore'),
    externals
  );
}

async function nccTerserWebpackPlugin() {
  externals['terser-webpack-plugin'] = 'next/dist/compiled/terser-webpack-plugin';
  await compileWithNcc(
    'terser-webpack-plugin',
    require.resolve('terser-webpack-plugin'),
    path.join(COMPILED_DIR, 'terser-webpack-plugin'),
    externals
  );
}

async function nccCommentJson() {
  externals['comment-json'] = 'next/dist/compiled/comment-json';
  await compileWithNcc(
    'comment-json',
    require.resolve('comment-json'),
    path.join(COMPILED_DIR, 'comment-json'),
    externals
  );
}

async function nccSemver() {
  externals['semver'] = 'next/dist/compiled/semver';
  await compileWithNcc(
    'semver',
    require.resolve('semver'),
    path.join(COMPILED_DIR, 'semver'),
    externals
  );
}

// NCC 打包任务：运行所有 NCC 打包
async function runNcc() {
  await clearDir(COMPILED_DIR);
  await fs.ensureDir(COMPILED_DIR); // 确保 compiled 目录存在
  try {
  await Promise.all([
    nccAmphtmlValidator(),
    nccArg(),
    nccAsyncRetry(),
    nccAsyncSema(),
    nccBabelLoader(),
    nccCacheLoader(),
    nccChalk(),
    nccCiInfo(),
    nccCompression(),
    nccConf(),
    nccContentType(),
    nccCookie(),
    nccDebug(),
    nccDevalue(),
    nccEscapeStringRegexp(),
    nccEtag(),
    nccFileLoader(),
    nccFindUp(),
    nccFresh(),
    nccGzipSize(),
    nccHttpProxy(),
    nccIgnoreLoader(),
    nccIsDocker(),
    nccIsWsl(),
    nccJson5(),
    nccJsonwebtoken(),
    nccLodashCurry(),
    nccLruCache(),
    nccNanoid(),
    nccNodeFetch(),
    nccOra(),
    nccPostcssFlexbugsFixes(),
    nccPostcssLoader(),
    nccPostcssPresetEnv(),
    nccRawBody(),
    nccRecast(),
    nccResolve(),
    nccSend(),
    nccSourceMap(),
    nccStringHash(),
    nccStripAnsi(),
    nccTerser(),
    nccTextTable(),
    nccThreadLoader(),
    nccUnistore(),
    nccTerserWebpackPlugin(),
    nccCommentJson(),
    nccSemver(),
  ]);
} catch (err) {
  console.error(`runNcc 失败: ${err.message}`);
  throw err;
}

}


// Polyfill 任务：处理 path-to-regexp
async function pathToRegexp() {
  const src = relative(__dirname, require.resolve('path-to-regexp'));
  const dest = path.join(DIST_DIR, 'build', 'path-to-regexp.js');
  await copyFiles(src, dest);
  console.log(`已复制 path-to-regexp 到 ${dest}`);
}


// 预编译任务：运行 polyfills、path-to-regexp 和 NCC 打包
async function precompile() {
  await runNcc(); // 先运行 NCC 打包，确保 compiled 目录存在
  await Promise.all([browserPolyfills(), pathToRegexp(), copyNcced()]);
}

// 编译任务：处理 Next.js 的各个模块
async function bin() {
  await compileWithBabel('bin/*', 'dist/bin', 'server', { stripExtension: true });
  const files = await fs.readdir('dist/bin');
  for (const file of files) {
    await fs.chmod(path.join('dist/bin', file), '0755');
  }
}

async function cli() {
  await compileWithBabel('cli/**/*.+(js|ts|tsx)', 'dist/cli', 'server');
}

async function lib() {
  await compileWithBabel('lib/**/*.+(js|ts|tsx)', 'dist/lib', 'server');
}

async function server() {
  await compileWithBabel('server/**/*.+(js|ts|tsx)', 'dist/server', 'server');
}

async function nextbuild() {
  await compileWithBabel('build/**/*.+(js|ts|tsx)', 'dist/build', 'server');
}

async function client() {
  await compileWithBabel('client/**/*.+(js|ts|tsx)', 'dist/client', 'client');
}

async function nextbuildstatic() {
  await compileWithBabel('export/**/*.+(js|ts|tsx)', 'dist/export', 'server');
}

async function pagesApp() {
  await compileWithBabel('pages/_app.tsx', 'dist/pages', 'client');
}

async function pagesError() {
  await compileWithBabel('pages/_error.tsx', 'dist/pages', 'client');
}

async function pagesDocument() {
  await compileWithBabel('pages/_document.tsx', 'dist/pages', 'server');
}

async function pages() {
  await Promise.all([pagesApp(), pagesError(), pagesDocument()]);
}

async function telemetry() {
  await compileWithBabel('telemetry/**/*.+(js|ts|tsx)', 'dist/telemetry', 'server');
}

async function nextserver() {
  await compileWithBabel('next-server/**/*.+(js|ts|tsx)', 'dist/next-server', 'server');
}

async function compile() {
  await Promise.all([
    cli(),
    bin(),
    server(),
    nextbuild(),
    nextbuildstatic(),
    pages(),
    lib(),
    client(),
    telemetry(),
    nextserver(),
  ]);
}

async function build() {
  await precompile();
  await compile();
}

async function release() {
  await clearDir(DIST_DIR);
  await build();
}

async function watch() {
  const watcher = chokidar.watch([
    'bin/*',
    'pages/**/*.+(js|ts|tsx)',
    'server/**/*.+(js|ts|tsx)',
    'build/**/*.+(js|ts|tsx)',
    'export/**/*.+(js|ts|tsx)',
    'client/**/*.+(js|ts|tsx)',
    'lib/**/*.+(js|ts|tsx)',
    'cli/**/*.+(js|ts|tsx)',
    'telemetry/**/*.+(js|ts|tsx)',
    'next-server/**/*.+(js|ts|tsx)',
  ], {
    cwd: __dirname,
    ignoreInitial: false,
    ignored: ['**/node_modules/**', '**/*.d.ts', '**/dist/**', '**/compiled/**'],
    persistent: true,
  });


  watcher.on('ready', () => {
    console.log('文件监听器已启动，监听路径: build, client, server, bundled, shared');
  });

  watcher.on('add', async (file) => {
    console.log(`检测到新增文件: ${file}`);
    try {
      await compileWithBabel(file);
      console.log(`编译完成: ${file}`);
    } catch (err) {
      console.error(`编译 ${file} 失败: ${err.message}`);
      notify(`编译 ${file} 失败`, err);
    }
  });


  watcher
    .on('change', async (file) => {
      console.log(`文件变更: ${file}`);
      try {
        if (file.startsWith('bin/')) await bin();
        if (file.startsWith('pages/')) await pages();
        if (file.startsWith('server/')) await server();
        if (file.startsWith('build/')) await nextbuild();
        if (file.startsWith('export/')) await nextbuildstatic();
        if (file.startsWith('client/')) await client();
        if (file.startsWith('lib/')) await lib();
        if (file.startsWith('cli/')) await cli();
        if (file.startsWith('telemetry/')) await telemetry();
        if (file.startsWith('next-server/')) await nextserver();

      } catch (err) {
        console.error(`编译 ${file} 失败: ${err.message}`);
        notify(`编译 ${file} 失败`, err);
      }



    })
    ;


    watcher.on('error', (err) => {
      console.error(`文件监听错误: ${err.message}`);
    });
  
    watcher.on('all', (event, file) => {
      console.log(`监听事件: ${event}, 文件: ${file}`);
    });



  console.log('正在监听文件变更...');
}

async function main() {
  await clearDir(DIST_DIR);
  await build();
  await watch();
}

main().catch((err) => {
  console.error('构建失败:', err);
  process.exit(1);
});

module.exports = {
  build,
  release,
  runNcc,
  compile,
  precompile,
  watch,
};