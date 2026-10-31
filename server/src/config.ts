import os from 'node:os';
import path from 'node:path';

/** 仓库根目录（server/dist/config.js -> server/dist -> server -> 根） */
export const ROOT = path.resolve(__dirname, '..', '..');
export const WEB_DIR = path.join(ROOT, 'web');
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
export const BIN_DIR = path.join(ROOT, 'bin');
export const LOG_DIR = path.join(ROOT, 'logs');

/** 进程间 Unix Domain Socket 目录（不进仓库，重启即重建） */
export const SOCK_DIR = process.env.SOCK_DIR || path.join(os.tmpdir(), 'qwen-board');
export const CORE_SOCK = path.join(SOCK_DIR, 'core.sock');
export const JOURNAL_SOCK = path.join(SOCK_DIR, 'journal.sock');

export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || '0.0.0.0';
export const ANALYTICS_PORT = Number(process.env.ANALYTICS_PORT || 7102);
export const ANALYTICS_URL = `http://127.0.0.1:${ANALYTICS_PORT}`;

/** 数字上限，与 C 内核保持一致（1e12） */
export const NUM_CAP = 1_000_000_000_000;
export const TEXT_CAP = 200;
