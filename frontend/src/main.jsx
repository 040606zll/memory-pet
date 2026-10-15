import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AuthProvider, AuthGate } from "./AuthProvider.jsx";

// 两个体验各自加载，普通记忆对话无需下载宠物动画运行时。
const isMemoryPage = window.location.pathname.replace(/\/$/, '') === '/memory';
document.title = isMemoryPage ? 'MemoryOS · 记忆对话' : 'MemoryOS · 机器狗宠物伙伴';
const Page = isMemoryPage
  ? lazy(() => import('./MemoryChat.jsx'))
  : lazy(() => import('./App.jsx').then(module => ({ default: module.App })));
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthProvider><AuthGate><Suspense fallback={<div role="status">正在打开对话…</div>}><Page /></Suspense></AuthGate></AuthProvider>
  </React.StrictMode>,
);
