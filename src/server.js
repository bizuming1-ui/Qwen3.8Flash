import { join, resolve } from 'node:path';
import { createInterfaceServer } from './app.js';

const rawPort = process.env.PORT || '3000';
const port = Number(rawPort);
const host = process.env.HOST || '0.0.0.0';
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('PORT 必须是 0 到 65535 之间的整数。');
  process.exit(1);
}

const databasePath = join(resolve(process.env.DATA_DIR || 'data'), 'interface.sqlite');
let app;
try {
  app = createInterfaceServer({ databasePath });
} catch (error) {
  console.error('启动失败:', error.message);
  process.exit(1);
}

app.server.on('error', async (error) => {
  console.error('服务器错误:', error.message);
  await app.close();
  process.exitCode = 1;
});

app.server.listen(port, host, () => {
  const address = app.server.address();
  console.log(`界面1已启动：http://localhost:${address.port}/`);
  console.log(`数据文件：${databasePath}`);
  if (process.env.PUBLIC_URL) console.log(`二维码分享地址：${process.env.PUBLIC_URL}`);
  else console.log('二维码使用当前访问地址；本机访问时会尝试使用局域网地址。');
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error('关闭服务器时发生错误:', error);
    process.exit(1);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
