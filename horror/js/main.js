// main.js — 集成入口（协调者维护）
// 职责：等待 DOM、引导加载幕、启动 Engine。各功能模块由 Engine 编排。
import { Engine } from './engine.js';

const boot = document.getElementById('boot');

function hideBoot() {
  if (!boot) return;
  boot.classList.add('boot-done');
  setTimeout(() => boot && boot.setAttribute('aria-hidden', 'true'), 1200);
}

async function main() {
  const root = document.getElementById('game');
  try {
    Engine.init(root);
    // Engine 准备就绪后由它决定何时呈现标题画面
    Engine.start();
  } catch (err) {
    console.error('启动失败：', err);
    root.innerHTML = '<div class="fatal">这里什么都没有了。<br><small>' +
      (err && err.message ? err.message : '未知错误') + '</small></div>';
  } finally {
    // 给加载幕一点呼吸感再退场
    setTimeout(hideBoot, 600);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
