# brotli-wasm 第三方说明

- 上游：[HTTP Toolkit / brotli-wasm](<https://github.com/httptoolkit/brotli-wasm>)，固定版本 **3.0.1**。
- 原始包：[brotli-wasm-3.0.1.tgz](<https://registry.npmjs.org/brotli-wasm/-/brotli-wasm-3.0.1.tgz>)。
- NPM `dist.integrity`：`sha512-U3K72/JAi3jITpdhZBqzSUq+DUY697tLxOuFXB+FpAE/Ug+5C3VZrv4uA674EUZHxNAuQ9wETXNqQkxZD6oL4A==`；下载后已验证一致。
- 许可证：Apache-2.0，完整副本为 [LICENSE](<LICENSE>)。本库由上游将 Rust Brotli 编译为 WebAssembly；原包没有独立 NOTICE 文件。

## 自托管文件

| 本仓库文件 | 原包来源 | SHA-256 |
|---|---|---|
| [brotli_wasm.mjs](<brotli_wasm.mjs>) | `package/pkg.web/brotli_wasm.js` | `cd7c6ad22230d9ad5618f4bc5b1a032677a18bcc9c7abecba6d5439beff031bc` |
| [brotli_wasm_bg.wasm](<brotli_wasm_bg.wasm>) | `package/pkg.web/brotli_wasm_bg.wasm` | `9ef0a025046bf7d87b7cdb8eac3f73a5c8fea2f1adb848cc9768345573fcd8a9` |
| [brotli_wasm.d.ts](<brotli_wasm.d.ts>) | `package/pkg.web/brotli_wasm.d.ts` | 原始类型定义 |

JavaScript 仅改扩展名为 `.mjs` 以便本地及浏览器明确识别 ES module；内容字节没有改写。WebAssembly 和许可证按原包字节保存。自身的主线程/worker包装位于上级目录，不属于第三方源码。

浏览器加载器只使用该库的流式解码；生产压缩通过 Node.js 原生 Brotli，不下载或执行运行时 CDN 脚本。发布必须包含本说明与许可证，并保持原始点位和压缩数据完整性校验。
