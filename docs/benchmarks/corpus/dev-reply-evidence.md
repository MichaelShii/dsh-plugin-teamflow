实现完成，改动 persist.js 存储封装。

[Verification evidence]
- cmd: node test/verify-persist.cjs → exit 0, 12/12 passed
- cmd: node test/verify-game.cjs → exit 0, 52/52 passed
- cmd: pnpm run typecheck → exit 0, 0 errors

<!-- state -->{"phase":"dev","summary":"持久化修复完成","touched":["/persist.js"]}<!-- /state -->
