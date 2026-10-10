// 本機設定；路徑都可以用環境變數覆寫
import path from 'node:path';

export const KEYWORDS = ['7-11 商品卡', '統一超商 商品卡', '7-ELEVEN 商品卡', '711 禮物卡', '統一超商 禮券'];
export const PAGES_PER_KEYWORD = 2; // 每頁 60 筆
export const REQUEST_DELAY_MS = [2000, 4000]; // 每次搜尋之間隨機等一下，比較像真人

// 瀏覽器設定檔、AI 快取、執行紀錄都放這裡（不要放 OneDrive，Chrome 設定檔很大又一直變）
export const RADAR_HOME = process.env.RADAR_HOME || 'E:\\711-radar';
export const PROFILE_DIR = path.join(RADAR_HOME, 'chrome-profile');
export const LLM_CACHE_FILE = path.join(RADAR_HOME, 'llm-cache.json');
export const LOG_FILE = path.join(RADAR_HOME, 'update.log');
export const RAW_FILE = path.join(RADAR_HOME, 'last-search.json');

export const OLLAMA_DIR = process.env.OLLAMA_DIR || 'E:\\ollama';
export const OLLAMA_MODELS = process.env.OLLAMA_MODELS || path.join(OLLAMA_DIR, 'models');
export const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:4b';
