import { createApp } from './app.js';

const app = await createApp();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const server = app.listen(port, host, () => {
  console.log(`分寸记账已启动：http://${host}:${port}`);
  if (process.env.NODE_ENV !== 'production' && process.env.DISABLE_DEMO !== 'true') {
    console.log('本地演示账户：demo@fencun.local / Fencun2026!');
  }
});

function close() {
  server.close(() => {
    Promise.resolve(app.locals.database.close()).finally(() => process.exit(0));
  });
}

process.on('SIGINT', close);
process.on('SIGTERM', close);
